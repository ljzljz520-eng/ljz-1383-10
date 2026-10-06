'use strict';
const express = require('express');
const { httpError, isoNow } = require('../util');
const { requireAdmin } = require('../auth');

module.exports = function adminRoutes(ctx) {
  const { db, vis, publish } = ctx;
  const r = express.Router();
  r.use(requireAdmin);

  // ---------- 影片与版本 ----------
  r.post('/films', (req, res) => {
    const { title, original_title = '', year = null, director_name, synopsis = '', fallback_text = '' } = req.body || {};
    if (!title || !director_name) throw httpError(400, 'missing_fields', 'title 与 director_name 必填');
    const id = db.run(
      `INSERT INTO films (title, original_title, year, director_name, synopsis, fallback_text, created_at)
       VALUES (?,?,?,?,?,?,?)`,
      [title, original_title, year, director_name, synopsis, fallback_text, isoNow()]
    );
    res.status(201).json({ id });
  });

  r.get('/films', (req, res) => {
    const films = db.all('SELECT * FROM films ORDER BY id DESC');
    const out = films.map((f) => ({
      ...f,
      versions: db.all('SELECT * FROM versions WHERE film_id=? ORDER BY id', [f.id]),
    }));
    res.json({ films: out });
  });

  r.post('/films/:id/versions', (req, res) => {
    const film = db.get('SELECT * FROM films WHERE id=?', [Number(req.params.id)]);
    if (!film) throw httpError(404, 'film_not_found');
    const { label, cut_note = '', runtime_sec = 0 } = req.body || {};
    if (!['festival', 'public', 'director'].includes(label)) throw httpError(400, 'invalid_label', 'label ∈ festival|public|director');
    const id = db.run(
      `INSERT INTO versions (film_id, label, cut_note, runtime_sec, status, created_at, updated_at)
       VALUES (?,?,?,?, 'draft', ?, ?)`,
      [film.id, label, cut_note, runtime_sec, isoNow(), isoNow()]
    );
    res.status(201).json({ id });
  });

  r.get('/versions', (req, res) => {
    const filmId = Number(req.query.film_id);
    const rows = filmId
      ? db.all('SELECT * FROM versions WHERE film_id=? ORDER BY id', [filmId])
      : db.all('SELECT * FROM versions ORDER BY id');
    res.json({ versions: rows });
  });

  // 发布（即时或定时）；冲突返回 409，force=true 显式替换
  r.post('/versions/:id/publish', (req, res) => {
    const { slot = 'web_public', scheduled_at = null, force = false } = req.body || {};
    const result = publish.publish({
      versionId: Number(req.params.id),
      actor: req.admin.name,
      slot,
      scheduledAt: scheduled_at,
      force: !!force,
    });
    res.json(result);
  });

  r.post('/versions/:id/unpublish', (req, res) => {
    res.json(publish.unpublish(Number(req.params.id), req.admin.name));
  });

  // 字幕修订：修订号 +1 并登记新字幕素材，历史放映记录仍指向原版本
  r.post('/versions/:id/subtitle-revision', (req, res) => {
    const v = db.get('SELECT * FROM versions WHERE id=?', [Number(req.params.id)]);
    if (!v) throw httpError(404, 'version_not_found');
    const storagePath = (req.body && req.body.storage_path) || '';
    const result = db.tx(() => {
      const next = v.subtitle_revision + 1;
      db.run('UPDATE versions SET subtitle_revision=?, updated_at=? WHERE id=?', [next, isoNow(), v.id]);
      let assetId = null;
      if (storagePath) {
        assetId = db.run(
          `INSERT INTO assets (film_id, version_id, kind, storage_path, revision, created_at) VALUES (?,?,?,?,?,?)`,
          [v.film_id, v.id, 'subtitle', storagePath, next, isoNow()]
        );
      }
      vis.invalidate(v.film_id);
      return { version_id: v.id, subtitle_revision: next, subtitle_asset_id: assetId };
    });
    res.json(result);
  });

  // ---------- 素材 ----------
  r.post('/assets', (req, res) => {
    const { film_id, version_id = null, kind, storage_path, is_public_clip = false } = req.body || {};
    if (!film_id || !kind || !storage_path) throw httpError(400, 'missing_fields', 'film_id/kind/storage_path 必填');
    if (!['poster', 'still', 'trailer', 'clip', 'full', 'subtitle'].includes(kind)) throw httpError(400, 'invalid_kind');
    const film = db.get('SELECT * FROM films WHERE id=?', [film_id]);
    if (!film) throw httpError(404, 'film_not_found');
    if (['trailer', 'clip', 'full', 'subtitle'].includes(kind)) {
      const v = version_id ? db.get('SELECT * FROM versions WHERE id=?', [version_id]) : null;
      if (!v) throw httpError(400, 'version_required', `${kind} 类素材必须绑定版本`);
    }
    const id = db.run(
      `INSERT INTO assets (film_id, version_id, kind, storage_path, is_public_clip, created_at) VALUES (?,?,?,?,?,?)`,
      [film_id, version_id, kind, storage_path, is_public_clip ? 1 : 0, isoNow()]
    );
    vis.invalidate(film_id);
    res.status(201).json({ id });
  });

  r.get('/assets', (req, res) => {
    const filmId = Number(req.query.film_id);
    res.json({ assets: filmId ? db.all('SELECT * FROM assets WHERE film_id=? ORDER BY id', [filmId]) : db.all('SELECT * FROM assets ORDER BY id') });
  });

  // ---------- 许可 ----------
  r.post('/licenses', (req, res) => {
    const { film_id, asset_kind, territory = 'GLOBAL', media = 'web', starts_at, ends_at } = req.body || {};
    if (!film_id || !asset_kind || !starts_at || !ends_at) throw httpError(400, 'missing_fields');
    if (!['poster', 'still', 'trailer', 'clip', 'full'].includes(asset_kind)) throw httpError(400, 'invalid_asset_kind');
    const id = db.run(
      `INSERT INTO licenses (film_id, asset_kind, territory, media, starts_at, ends_at, status, created_by, created_at)
       VALUES (?,?,?,?,?,?, 'active', ?, ?)`,
      [film_id, asset_kind, territory.toUpperCase(), media, starts_at, ends_at, req.admin.name, isoNow()]
    );
    vis.invalidate(film_id);
    res.status(201).json({ id });
  });

  r.get('/licenses', (req, res) => {
    const filmId = Number(req.query.film_id);
    res.json({ licenses: filmId ? db.all('SELECT * FROM licenses WHERE film_id=? ORDER BY id', [filmId]) : db.all('SELECT * FROM licenses ORDER BY id') });
  });

  // 授权提前结束：立即终止并主动失效缓存
  r.post('/licenses/:id/terminate', (req, res) => {
    const lic = db.get('SELECT * FROM licenses WHERE id=?', [Number(req.params.id)]);
    if (!lic) throw httpError(404, 'license_not_found');
    db.run(`UPDATE licenses SET status='terminated', terminated_at=? WHERE id=?`, [isoNow(), lic.id]);
    vis.invalidate(lic.film_id);
    res.json({ id: lic.id, status: 'terminated', terminated_at: isoNow() });
  });

  // ---------- 放映记录（支持补录历史场次） ----------
  r.post('/screenings', (req, res) => {
    const { version_id, festival_name = '', venue, city = '', country = '', screened_at, notes = '' } = req.body || {};
    if (!version_id || !venue || !screened_at) throw httpError(400, 'missing_fields', 'version_id/venue/screened_at 必填');
    const v = db.get('SELECT * FROM versions WHERE id=?', [version_id]);
    if (!v) throw httpError(404, 'version_not_found', '放映记录必须绑定实际版本');
    const id = db.run(
      `INSERT INTO screenings (version_id, festival_name, venue, city, country, screened_at, notes, created_by, created_at)
       VALUES (?,?,?,?,?,?,?,?,?)`,
      [version_id, festival_name, venue, city, country, screened_at, notes, req.admin.name, isoNow()]
    );
    res.status(201).json({ id, version_id, film_id: v.film_id });
  });

  // ---------- 署名（原文记录，可核实标记） ----------
  r.post('/credits', (req, res) => {
    const { film_id, person_name, role, verified = false, source = '' } = req.body || {};
    if (!film_id || !person_name || !role) throw httpError(400, 'missing_fields');
    const id = db.run(
      `INSERT INTO credits (film_id, person_name, role, verified, source, created_at) VALUES (?,?,?,?,?,?)`,
      [film_id, person_name, role, verified ? 1 : 0, source, isoNow()]
    );
    res.status(201).json({ id });
  });

  // ---------- 合作申请队列（按类别分流，私密材料隔离） ----------
  r.get('/contacts', (req, res) => {
    const cat = req.query.category;
    const rows = cat
      ? db.all('SELECT id, category, name, email, org, message, routed_to, has_private_material, status, created_at FROM contacts WHERE category=? ORDER BY id DESC', [cat])
      : db.all('SELECT id, category, name, email, org, message, routed_to, has_private_material, status, created_at FROM contacts ORDER BY id DESC');
    res.json({ contacts: rows }); // 注意：绝不返回 private_material_path
  });

  r.post('/contacts/:id/status', (req, res) => {
    const c = db.get('SELECT * FROM contacts WHERE id=?', [Number(req.params.id)]);
    if (!c) throw httpError(404, 'contact_not_found');
    const status = (req.body && req.body.status) || '';
    if (!['new', 'in_review', 'closed'].includes(status)) throw httpError(400, 'invalid_status');
    db.run('UPDATE contacts SET status=? WHERE id=?', [status, c.id]);
    res.json({ id: c.id, status });
  });

  // 私密材料：仅管理员经认证接口读取，存储于公开目录之外
  r.get('/contacts/:id/material', (req, res) => {
    const c = db.get('SELECT * FROM contacts WHERE id=?', [Number(req.params.id)]);
    if (!c || !c.has_private_material || !c.private_material_path) throw httpError(404, 'no_material');
    const fs = require('fs');
    if (!fs.existsSync(c.private_material_path)) throw httpError(404, 'material_missing');
    res.setHeader('Content-Type', 'application/octet-stream');
    fs.createReadStream(c.private_material_path).pipe(res);
  });

  // 发布审计日志
  r.get('/publish-events', (req, res) => {
    res.json({ events: db.all('SELECT * FROM publish_events ORDER BY id DESC LIMIT 200') });
  });

  // 手动触发定时上线（服务器也按周期自动执行）
  r.post('/scheduler/run', (req, res) => {
    res.json({ results: publish.runDue() });
  });

  return r;
};
