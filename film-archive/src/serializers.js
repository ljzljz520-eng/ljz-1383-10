'use strict';

const LICENSED_KINDS = ['poster', 'still', 'trailer', 'clip', 'full'];

/** 单个素材的可见性：许可 + 版本状态与槽位 + 公开片段批准，多重门槛 */
function assetVisible(db, vis, asset, region) {
  if (!vis.isLicensed(asset.film_id, asset.kind, region)) return false;
  if (asset.kind === 'poster' || asset.kind === 'still') return true; // 影片级素材
  const v = asset.version_id ? db.get('SELECT * FROM versions WHERE id=?', [asset.version_id]) : null;
  if (!v || v.status !== 'published') return false;
  // 媒介门槛：web 渠道只放行发布到 web_public 槽位的版本；
  // 影展线(festival_circuit)版本仅供影展放映，不因影片持有 web 许可而在线上泄露
  if (v.slot !== 'web_public') return false;
  if (asset.kind === 'clip' && !asset.is_public_clip) return false; // 公开片段需明确批准
  return true;
}

function visibleAssets(db, vis, filmId, region) {
  return db
    .all('SELECT * FROM assets WHERE film_id=?', [filmId])
    .filter((a) => assetVisible(db, vis, a, region));
}

/** 列表/搜索用的影片摘要 —— 与详情共用同一套可见性逻辑，保证"搜索与详情一致" */
function serializeFilmSummary(db, vis, film, region) {
  const assets = visibleAssets(db, vis, film.id, region);
  const availability = {};
  for (const k of LICENSED_KINDS) availability[k] = assets.some((a) => a.kind === k);
  const poster = assets.find((a) => a.kind === 'poster');
  return {
    id: film.id,
    title: film.title,
    original_title: film.original_title,
    year: film.year,
    director_name: film.director_name,
    synopsis: film.synopsis,
    availability,
    poster_media_id: poster ? poster.id : null,
    // 影片无法公开（完整影片不可见）时，下发经批准的文字说明
    notice: availability.full ? null : film.fallback_text || null,
  };
}

function serializeFilmDetail(db, vis, film, region) {
  const summary = serializeFilmSummary(db, vis, film, region);
  const versions = db
    .all(`SELECT * FROM versions WHERE film_id=? AND status='published' ORDER BY published_at DESC, id DESC`, [film.id])
    .map((v) => ({
      id: v.id,
      label: v.label,
      cut_note: v.cut_note,
      runtime_sec: v.runtime_sec,
      subtitle_revision: v.subtitle_revision,
      slot: v.slot,
      published_at: v.published_at,
      // 放映记录绑定实际版本，按版本分组返回，绝不按片名合并
      screenings: db.all(
        `SELECT id, festival_name, venue, city, country, screened_at, notes
         FROM screenings WHERE version_id=? ORDER BY screened_at DESC, id DESC`,
        [v.id]
      ),
    }));
  // 署名按来源原文呈现，verified 标记是否可核实，不做任何自动升格/合并
  const credits = db
    .all('SELECT person_name, role, verified, source FROM credits WHERE film_id=? ORDER BY id', [film.id])
    .map((c) => ({ person_name: c.person_name, role: c.role, verified: !!c.verified, source: c.source }));
  const assets = {};
  for (const a of visibleAssets(db, vis, film.id, region)) {
    (assets[a.kind] = assets[a.kind] || []).push(a.id);
  }
  return { ...summary, versions, credits, assets };
}

module.exports = { assetVisible, visibleAssets, serializeFilmSummary, serializeFilmDetail, LICENSED_KINDS };
