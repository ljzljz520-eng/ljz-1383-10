'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const { assetVisible } = require('../serializers');

const MIME = { '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.mp4': 'video/mp4', '.srt': 'text/plain; charset=utf-8', '.bin': 'application/octet-stream' };

module.exports = function mediaRoutes(ctx) {
  const { db, vis, downloadSecret } = ctx;
  const r = express.Router();
  const regionOf = (req) => (req.query.region || 'GLOBAL').toUpperCase();

  const b64u = (buf) => Buffer.from(buf).toString('base64url');
  const sign = (payloadB64) => crypto.createHmac('sha256', downloadSecret).update(payloadB64).digest('base64url');

  function loadAsset(id) {
    return db.get('SELECT * FROM assets WHERE id=?', [Number(id)]);
  }
  function fallbackNotice(asset) {
    if (!asset) return '该素材当前不可公开访问。';
    const film = db.get('SELECT fallback_text FROM films WHERE id=?', [asset.film_id]);
    return (film && film.fallback_text) || '该素材当前不可公开访问。';
  }

  /**
   * 媒体探测接口：只返回可用性元数据。
   * 无论素材是否可见，响应中都绝不包含存储路径或可访问原文件的地址。
   */
  r.get('/media/:id/probe', (req, res) => {
    const a = loadAsset(req.params.id);
    const region = regionOf(req);
    if (!a || !assetVisible(db, vis, a, region)) {
      return res.status(404).json({ available: false, notice: fallbackNotice(a) });
    }
    res.json({ available: true, id: a.id, kind: a.kind, film_id: a.film_id, revision: a.revision });
  });

  /** 文件流：内部读取存储并转发，路径不外泄；每次请求实时复查许可 */
  r.get('/media/:id/file', (req, res) => {
    const a = loadAsset(req.params.id);
    const region = regionOf(req);
    if (!a || !assetVisible(db, vis, a, region)) {
      return res.status(404).json({ available: false, notice: fallbackNotice(a) });
    }
    if (!fs.existsSync(a.storage_path)) return res.status(404).json({ available: false, notice: '文件暂缺，请联系档案管理员。' });
    res.setHeader('Content-Type', MIME[path.extname(a.storage_path)] || 'application/octet-stream');
    res.setHeader('Cache-Control', 'no-store'); // 可见性由许可实时决定，不允许客户端长缓存
    fs.createReadStream(a.storage_path).pipe(res);
  });

  /** 签发下载令牌（管理员）：短时效，使用时仍需复查许可 */
  r.post('/media/:id/download-token', (req, res) => {
    const a = loadAsset(req.params.id);
    const region = regionOf(req);
    if (!a || !assetVisible(db, vis, a, region)) {
      return res.status(403).json({ error: 'not_downloadable', notice: fallbackNotice(a) });
    }
    const payload = { a: a.id, f: a.film_id, r: region, exp: Date.now() + 60_000, n: crypto.randomBytes(8).toString('hex') };
    const p = b64u(JSON.stringify(payload));
    res.json({ token: `${p}.${sign(p)}`, expires_at: new Date(payload.exp).toISOString() });
  });

  /** 令牌下载：验签 + 过期检查 + 许可实时复查（权限在签发后变更则拒绝） */
  r.get('/download/:token', (req, res) => {
    const [p, sig] = (req.params.token || '').split('.');
    if (!p || !sig || sign(p) !== sig) return res.status(403).json({ error: 'invalid_token' });
    let payload;
    try { payload = JSON.parse(Buffer.from(p, 'base64url').toString('utf8')); } catch { return res.status(403).json({ error: 'invalid_token' }); }
    if (payload.exp < Date.now()) return res.status(403).json({ error: 'token_expired' });
    const a = loadAsset(payload.a);
    if (!a || !assetVisible(db, vis, a, payload.r || 'GLOBAL')) {
      return res.status(403).json({ error: 'permission_revoked', notice: fallbackNotice(a) });
    }
    if (!fs.existsSync(a.storage_path)) return res.status(404).json({ error: 'file_missing' });
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Cache-Control', 'no-store');
    fs.createReadStream(a.storage_path).pipe(res);
  });

  return r;
};
