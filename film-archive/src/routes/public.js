'use strict';
/**
 * 公开接口。
 * 一致性保证：搜索与详情使用同一个 buildFilmView() 可见性判定，
 * 因此列表里看不到的，详情同样不可见，反之亦然。
 * 安全保证：媒体探测接口只返回可用性与原因，绝不返回原始文件地址；
 * 实际文件只能通过短时效令牌访问，且下载开始时复核许可。
 */
const express = require('express');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const { evaluateAccessCached, evaluateAccess, latestAsset } = require('../license');

const TOKEN_TTL_MS = 60_000; // 下载令牌 60 秒
const CATEGORIES = ['cooperation', 'screening', 'interview'];

function stripInternal(view) {
  if (!view) return view;
  const { boundary, license_id, ...pub } = view;
  return pub;
}

module.exports = function publicRoutes(db) {
  const r = express.Router();

  /** 影片公开视图（搜索卡片与详情共用同一判定路径） */
  function buildFilmView(film, territory, { detailed }) {
    const at = new Date();
    const view = {
      id: film.id,
      title: film.title,
      original_title: film.original_title,
      year: film.year,
      synopsis: film.synopsis,
    };

    // 海报可用性（影片级媒介）——列表与详情都走这里
    const posterAsset = latestAsset(db, film.id, null, 'poster');
    const posterAccess = evaluateAccessCached(db, { filmId: film.id, mediaKind: 'poster', territory, at });
    view.poster = { available: posterAccess.allowed, reason: posterAccess.reason };

    // 当前已发布版本（受唯一索引约束至多一个）
    const pub = db.get(
      "SELECT * FROM versions WHERE film_id = ? AND status = 'published'", [film.id]);
    if (pub) {
      const rel = db.get(
        'SELECT approved, not_before FROM release_list WHERE version_id = ? AND approved = 1 ORDER BY id DESC LIMIT 1',
        [pub.id]);
      const nowIso = at.toISOString();
      const gated = rel && (!rel.not_before || rel.not_before <= nowIso);
      if (gated) {
        view.published_version = { id: pub.id, label: pub.label, runtime_sec: pub.runtime_sec };
        const full = evaluateAccessCached(db,
          { filmId: film.id, versionId: pub.id, mediaKind: 'full_film', territory, at });
        view.has_full_film = full.allowed;
      }
    }
    if (!view.has_full_film) view.has_full_film = false;

    if (!detailed) return view;

    // ---- 详情部分 ----
    // 署名：原样返回可核实职责，不做任何夸大聚合
    view.credits = db.all(
      'SELECT person_name, role, verified, source FROM credits WHERE film_id = ? ORDER BY id',
      [film.id]);

    // 各媒介可用性：预告/剧照/完整影片分别检查
    view.media = { poster: view.poster };
    for (const kind of ['still', 'trailer', 'clip', 'full_film']) {
      const versionId = ['trailer', 'clip', 'full_film'].includes(kind) && pub ? pub.id : null;
      const access = evaluateAccessCached(db,
        { filmId: film.id, versionId, mediaKind: kind, territory, at });
      const asset = access.allowed ? latestAsset(db, film.id, versionId, kind) : null;
      view.media[kind] = {
        available: access.allowed && !!asset,
        reason: access.reason,
        asset_id: access.allowed && asset ? asset.id : null,
      };
    }

    // 字幕：最新修订号
    if (pub) {
      const sub = latestAsset(db, film.id, pub.id, 'subtitle');
      if (sub) {
        const acc = evaluateAccessCached(db,
          { filmId: film.id, versionId: pub.id, mediaKind: 'subtitle', territory, at });
        view.subtitles = [{ revision: sub.revision, available: acc.allowed, asset_id: acc.allowed ? sub.id : null }];
      } else view.subtitles = [];
    }

    // 影片无法公开时：提供经批准的文字说明（未批准则不给任何替代文本）
    const fullAvail = view.media.full_film && view.media.full_film.available;
    if (!fullAvail && film.fallback_approved && film.fallback_text) {
      view.fallback_text = film.fallback_text;
    }

    // 放映记录：绑定具体版本并展示版本标签 —— 同名片不同剪辑绝不合并
    view.screenings = db.all(
      `SELECT s.id, s.event_name, s.venue, s.city, s.country, s.screened_at, s.source,
              v.id AS version_id, v.label AS version_label
         FROM screenings s JOIN versions v ON v.id = s.version_id
        WHERE s.film_id = ? ORDER BY s.screened_at DESC`, [film.id]);
    return view;
  }

  // 搜索
  r.get('/films', (req, res) => {
    const q = (req.query.query || '').trim();
    const territory = (req.query.territory || 'WORLD').toUpperCase();
    const rows = q
      ? db.all(
          `SELECT * FROM films WHERE catalog_visibility = 'public'
             AND (title LIKE ? OR IFNULL(original_title,'') LIKE ?) ORDER BY year DESC, id`,
          [`%${q}%`, `%${q}%`])
      : db.all(`SELECT * FROM films WHERE catalog_visibility = 'public' ORDER BY year DESC, id`);
    res.json({ films: rows.map((f) => buildFilmView(f, territory, { detailed: false })) });
  });

  // 详情
  r.get('/films/:id', (req, res) => {
    const film = db.get('SELECT * FROM films WHERE id = ?', [Number(req.params.id)]);
    if (!film || film.catalog_visibility !== 'public') {
      return res.status(404).json({ error: 'not_found' });
    }
    const territory = (req.query.territory || 'WORLD').toUpperCase();
    res.json(buildFilmView(film, territory, { detailed: true }));
  });

  /**
   * 媒体探测：只回答“能否看/为什么不能看”，永不返回文件地址。
   * 可用时也只给“申请下载”的端点，客户端须再换取短时效令牌。
   */
  r.get('/media/probe', (req, res) => {
    const territory = (req.query.territory || 'WORLD').toUpperCase();
    let asset = null;
    if (req.query.asset_id) {
      asset = db.get('SELECT * FROM assets WHERE id = ?', [Number(req.query.asset_id)]);
    } else if (req.query.version_id && req.query.kind) {
      asset = latestAsset(db, Number(req.query.version_id) && db.get(
        'SELECT film_id FROM versions WHERE id = ?', [Number(req.query.version_id)])?.film_id,
        Number(req.query.version_id), String(req.query.kind));
    }
    if (!asset) return res.status(404).json({ available: false, reason: 'asset_not_found' });

    const access = evaluateAccessCached(db, {
      filmId: asset.film_id, versionId: asset.version_id, mediaKind: asset.kind, territory,
    });
    const body = {
      asset_id: asset.id,
      kind: asset.kind,
      revision: asset.revision,
      available: access.allowed,
      reason: access.reason,
      // 可用时仅提供“申请入口”，不是文件地址
      download_endpoint: access.allowed ? `/api/media/${asset.id}/request-download` : null,
    };
    if (!access.allowed) {
      const film = db.get('SELECT fallback_text, fallback_approved FROM films WHERE id = ?', [asset.film_id]);
      if (film && film.fallback_approved && film.fallback_text) body.fallback_text = film.fallback_text;
    }
    res.json(body); // 注意：响应中绝无 storage_path
  });

  // 申请下载：实时判定许可后签发短时效令牌
  r.post('/media/:assetId/request-download', express.json(), (req, res) => {
    const asset = db.get('SELECT * FROM assets WHERE id = ?', [Number(req.params.assetId)]);
    if (!asset) return res.status(404).json({ error: 'asset_not_found' });
    const territory = ((req.body && req.body.territory) || 'WORLD').toUpperCase();

    // 下载是敏感操作：不用缓存，实时判定
    const access = evaluateAccess(db, {
      filmId: asset.film_id, versionId: asset.version_id, mediaKind: asset.kind, territory,
    });
    if (!access.allowed) return res.status(403).json({ error: 'forbidden', reason: access.reason });

    const token = crypto.randomBytes(24).toString('hex');
    const expires = new Date(Date.now() + TOKEN_TTL_MS).toISOString();
    db.run('INSERT INTO download_tokens(token, asset_id, territory, expires_at) VALUES (?,?,?,?)',
      [token, asset.id, territory, expires]);
    res.json({ token, expires_at: expires, stream_url: `/api/media/stream?token=${token}` });
  });

  // 流式/下载：校验令牌 + 下载开始时复核许可（权限变更即时生效）
  r.get('/media/stream', (req, res) => {
    const tok = db.get('SELECT * FROM download_tokens WHERE token = ?', [String(req.query.token || '')]);
    if (!tok || tok.revoked) return res.status(403).json({ error: 'invalid_token' });
    if (tok.expires_at <= new Date().toISOString()) {
      return res.status(403).json({ error: 'token_expired' });
    }
    const asset = db.get('SELECT * FROM assets WHERE id = ?', [tok.asset_id]);
    if (!asset) return res.status(404).json({ error: 'asset_not_found' });

    // 关键：令牌有效 ≠ 许可仍有效。下载开始时重新实时判定。
    const access = evaluateAccess(db, {
      filmId: asset.film_id, versionId: asset.version_id,
      mediaKind: asset.kind, territory: tok.territory || 'WORLD',
    });
    if (!access.allowed) return res.status(403).json({ error: 'forbidden', reason: access.reason });

    const abs = path.join(__dirname, '..', '..', asset.storage_path);
    if (!fs.existsSync(abs)) return res.status(404).json({ error: 'file_missing' });
    const types = { '.svg': 'image/svg+xml', '.jpg': 'image/jpeg', '.png': 'image/png',
      '.mp4': 'video/mp4', '.srt': 'text/plain; charset=utf-8', '.vtt': 'text/vtt' };
    res.setHeader('Content-Type', types[path.extname(abs)] || 'application/octet-stream');
    res.setHeader('Cache-Control', 'private, no-store');
    fs.createReadStream(abs).pipe(res);
  });

  // 联系表单：按 合作/放映/采访 分流；私密材料仅入库、公开接口永不返回
  r.post('/contact', express.json(), (req, res) => {
    const { category, name, email, org, message, private_material } = req.body || {};
    if (!CATEGORIES.includes(category)) {
      return res.status(400).json({ error: 'invalid_category', allowed: CATEGORIES });
    }
    if (!name || !email || !message) return res.status(400).json({ error: 'missing_fields' });
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return res.status(400).json({ error: 'invalid_email' });
    const id = db.insert(
      'INSERT INTO contact_requests(category,name,email,org,message,private_material) VALUES (?,?,?,?,?,?)',
      [category, name, email, org || null, message, private_material || null]);
    res.status(201).json({ id, category, status: 'received' }); // 不回显私密材料
  });

  return r;
};
