'use strict';
/**
 * 后台接口。所有变更写审计日志；影响可见性的变更 bumpEpoch() 使缓存立即失效。
 * 认证：x-admin-token（两名管理员 token-admin-a / token-admin-b）。
 */
const express = require('express');
const { bumpEpoch } = require('../cache');

const TOKENS = (process.env.ADMIN_TOKENS || 'token-admin-a:admin-a,token-admin-b:admin-b')
  .split(',').map((p) => p.split(':')).reduce((m, [t, name]) => (m[t] = name, m), {});

module.exports = function adminRoutes(db) {
  const r = express.Router();
  r.use(express.json());

  // 认证
  r.use((req, res, next) => {
    const actor = TOKENS[req.get('x-admin-token')];
    if (!actor) return res.status(401).json({ error: 'unauthorized' });
    req.actor = actor;
    next();
  });

  function audit(actor, action, entity, entityId, payload) {
    db.run('INSERT INTO audit_log(actor,action,entity,entity_id,payload) VALUES (?,?,?,?,?)',
      [actor, action, entity, entityId, JSON.stringify(payload || {})]);
  }
  const now = () => new Date().toISOString();

  // ---- 影片 ----
  r.post('/films', (req, res) => {
    const { title, original_title, year, synopsis, fallback_text, fallback_approved } = req.body || {};
    if (!title) return res.status(400).json({ error: 'title_required' });
    const id = db.insert(
      'INSERT INTO films(title,original_title,year,synopsis,fallback_text,fallback_approved) VALUES (?,?,?,?,?,?)',
      [title, original_title || null, year || null, synopsis || null, fallback_text || null, fallback_approved ? 1 : 0]);
    audit(req.actor, 'create', 'film', id, { title });
    bumpEpoch();
    res.status(201).json({ id });
  });

  r.post('/films/:id/credits', (req, res) => {
    const { person_name, role, verified, source } = req.body || {};
    if (!person_name || !role) return res.status(400).json({ error: 'person_and_role_required' });
    // 原样记录职责；verified 必须带来源，保证“可核实”
    if (verified && !source) return res.status(400).json({ error: 'verified_credit_requires_source' });
    const id = db.insert(
      'INSERT INTO credits(film_id,person_name,role,verified,source) VALUES (?,?,?,?,?)',
      [Number(req.params.id), person_name, role, verified ? 1 : 0, source || null]);
    audit(req.actor, 'create', 'credit', id, { person_name, role });
    res.status(201).json({ id });
  });

  // ---- 剪辑版本 ----
  r.post('/versions', (req, res) => {
    const { film_id, label, cut_note, runtime_sec } = req.body || {};
    if (!film_id || !['festival', 'public', 'director'].includes(label)) {
      return res.status(400).json({ error: 'film_id_and_valid_label_required' });
    }
    const seq = (db.get('SELECT COALESCE(MAX(seq),0) AS m FROM versions WHERE film_id=? AND label=?',
      [film_id, label]).m) + 1;
    const id = db.insert(
      'INSERT INTO versions(film_id,label,cut_note,runtime_sec,seq,created_by) VALUES (?,?,?,?,?,?)',
      [film_id, label, cut_note || null, runtime_sec || null, seq, req.actor]);
    audit(req.actor, 'create', 'version', id, { film_id, label, seq });
    bumpEpoch();
    res.status(201).json({ id, seq });
  });

  /**
   * 发布版本：事务内完成“归档旧版 + 发布新版”。
   * 部分唯一索引 one_published_version_per_film 兜底并发：
   * 两名管理员同时发布不同剪辑时，后到的事务失败 → 409。
   * supersede=true 才允许替换当前已发布版本。
   */
  r.post('/versions/:id/publish', (req, res) => {
    const vid = Number(req.params.id);
    const supersede = !!(req.body && req.body.supersede);
    try {
      const result = db.tx(() => {
        const v = db.get('SELECT * FROM versions WHERE id = ?', [vid]);
        if (!v) throw Object.assign(new Error('not_found'), { status: 404 });
        if (v.status === 'published') return { already: true };
        const current = db.get(
          "SELECT * FROM versions WHERE film_id = ? AND status = 'published'", [v.film_id]);
        if (current && !supersede) {
          throw Object.assign(new Error('another_version_published'), {
            status: 409, current_version_id: current.id, current_label: current.label });
        }
        if (current) {
          db.run("UPDATE versions SET status = 'archived' WHERE id = ?", [current.id]);
        }
        db.run("UPDATE versions SET status = 'published', published_by = ?, published_at = ? WHERE id = ?",
          [req.actor, now(), vid]);
        return { published: vid, superseded: current ? current.id : null };
      });
      audit(req.actor, 'publish', 'version', vid, result);
      bumpEpoch();
      res.json(result);
    } catch (e) {
      if (e.status === 409) {
        return res.status(409).json({ error: e.message, current_version_id: e.current_version_id, current_label: e.current_label });
      }
      if (e.status === 404) return res.status(404).json({ error: 'version_not_found' });
      if (/UNIQUE/.test(String(e.message))) {
        return res.status(409).json({ error: 'concurrent_publish_conflict' });
      }
      throw e;
    }
  });

  // ---- 发布清单（预先批准 + 定时上线门控）----
  r.post('/release-list', (req, res) => {
    const { version_id, approved, not_before } = req.body || {};
    if (!version_id) return res.status(400).json({ error: 'version_id_required' });
    const id = db.insert(
      'INSERT INTO release_list(version_id,approved,approved_by,not_before) VALUES (?,?,?,?)',
      [version_id, approved ? 1 : 0, req.actor, not_before || null]);
    audit(req.actor, 'upsert', 'release_list', id, { version_id, approved, not_before });
    bumpEpoch();
    res.status(201).json({ id });
  });

  // ---- 资产与字幕修订 ----
  r.post('/assets', (req, res) => {
    const { film_id, version_id, kind, storage_path } = req.body || {};
    if (!film_id || !kind || !storage_path) return res.status(400).json({ error: 'missing_fields' });
    const id = db.insert(
      'INSERT INTO assets(film_id,version_id,kind,storage_path) VALUES (?,?,?,?)',
      [film_id, version_id || null, kind, storage_path]);
    audit(req.actor, 'create', 'asset', id, { film_id, kind });
    bumpEpoch();
    res.status(201).json({ id });
  });

  /** 字幕修订：新增一行 revision+1，旧修订保留可回溯 */
  r.post('/assets/:id/revise', (req, res) => {
    const old = db.get('SELECT * FROM assets WHERE id = ?', [Number(req.params.id)]);
    if (!old) return res.status(404).json({ error: 'asset_not_found' });
    const nextRev = (db.get('SELECT COALESCE(MAX(revision),0) AS m FROM assets WHERE film_id=? AND kind=? AND IFNULL(version_id,-1)=IFNULL(?,-1)',
      [old.film_id, old.kind, old.version_id]).m) + 1;
    const storagePath = (req.body && req.body.storage_path) || old.storage_path;
    const id = db.insert(
      'INSERT INTO assets(film_id,version_id,kind,revision,storage_path) VALUES (?,?,?,?,?)',
      [old.film_id, old.version_id, old.kind, nextRev, storagePath]);
    audit(req.actor, 'revise', 'asset', id, { from: old.id, revision: nextRev });
    bumpEpoch();
    res.status(201).json({ id, revision: nextRev, supersedes: old.id });
  });

  // ---- 许可 ----
  r.post('/licenses', (req, res) => {
    const { film_id, version_id, media_kind, territories, start_at, end_at } = req.body || {};
    if (!film_id || !media_kind || !start_at) return res.status(400).json({ error: 'missing_fields' });
    const id = db.insert(
      'INSERT INTO licenses(film_id,version_id,media_kind,territories,start_at,end_at,approved_by) VALUES (?,?,?,?,?,?,?)',
      [film_id, version_id || null, media_kind,
       JSON.stringify(territories && territories.length ? territories : ['WORLD']),
       start_at, end_at || null, req.actor]);
    audit(req.actor, 'create', 'license', id, { film_id, media_kind });
    bumpEpoch();
    res.status(201).json({ id });
  });

  /** 授权提前结束：立即生效（bumpEpoch 使所有缓存可见性作废） */
  r.post('/licenses/:id/terminate', (req, res) => {
    const lic = db.get('SELECT * FROM licenses WHERE id = ?', [Number(req.params.id)]);
    if (!lic) return res.status(404).json({ error: 'license_not_found' });
    db.run("UPDATE licenses SET status='terminated', terminated_at=?, termination_reason=? WHERE id=?",
      [now(), (req.body && req.body.reason) || null, lic.id]);
    // 不吊销已签发令牌：流式接口在下载开始时实时复核许可，
    // 以许可判定为唯一权威执行点，拒绝原因更精确（license_terminated 而非 invalid_token）
    audit(req.actor, 'terminate', 'license', lic.id, { reason: req.body && req.body.reason });
    bumpEpoch();
    res.json({ id: lic.id, status: 'terminated' });
  });

  // ---- 放映记录补录：强制绑定版本，且版本必须属于该影片 ----
  r.post('/screenings', (req, res) => {
    const { film_id, version_id, event_name, venue, city, country, screened_at, source } = req.body || {};
    if (!film_id || !version_id || !screened_at) {
      return res.status(400).json({ error: 'film_id_version_id_screened_at_required' });
    }
    const v = db.get('SELECT * FROM versions WHERE id = ?', [version_id]);
    if (!v || v.film_id !== film_id) {
      return res.status(422).json({ error: 'version_does_not_belong_to_film' });
    }
    const id = db.insert(
      'INSERT INTO screenings(film_id,version_id,event_name,venue,city,country,screened_at,source) VALUES (?,?,?,?,?,?,?,?)',
      [film_id, version_id, event_name || null, venue || null, city || null,
       country || null, screened_at, source || null]);
    audit(req.actor, 'backfill', 'screening', id, { film_id, version_id, screened_at });
    res.status(201).json({ id });
  });

  // ---- 联系表单队列：按类别隔离；私密材料仅在此可见 ----
  r.get('/contacts', (req, res) => {
    const cat = req.query.category;
    const rows = cat
      ? db.all('SELECT * FROM contact_requests WHERE category = ? ORDER BY id DESC', [cat])
      : db.all('SELECT * FROM contact_requests ORDER BY id DESC');
    res.json({ contacts: rows });
  });

  r.post('/contacts/:id/status', (req, res) => {
    const status = (req.body && req.body.status) || 'processed';
    db.run('UPDATE contact_requests SET status = ? WHERE id = ?', [status, Number(req.params.id)]);
    audit(req.actor, 'update_status', 'contact', Number(req.params.id), { status });
    res.json({ ok: true });
  });

  // ---- 审计与总览 ----
  r.get('/audit', (req, res) => {
    res.json({ audit: db.all('SELECT * FROM audit_log ORDER BY id DESC LIMIT 100') });
  });

  r.get('/overview', (req, res) => {
    res.json({
      films: db.all('SELECT * FROM films ORDER BY id'),
      versions: db.all('SELECT * FROM versions ORDER BY film_id, id'),
      licenses: db.all('SELECT * FROM licenses ORDER BY id'),
      release_list: db.all('SELECT * FROM release_list ORDER BY id'),
      assets: db.all('SELECT id, film_id, version_id, kind, revision FROM assets ORDER BY id'),
      screenings: db.all('SELECT * FROM screenings ORDER BY id'),
    });
  });

  return r;
};
