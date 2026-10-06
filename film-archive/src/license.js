'use strict';
/**
 * 许可判定引擎 —— 方案选择（详见 README）：
 *   采用「按许可实时计算可见性」为权威真源；
 *   「预先批准的发布清单」仅作为必要门控条件之一（防御纵深），
 *   而不是可见性真源 —— 否则授权提前终止时清单已发、内容仍会泄漏。
 *
 * 判定链：版本状态 → 发布清单门控(批准+定时上线) → 许可(状态/时段/地域)。
 * 预告、剧照、完整影片等每种媒介分别检查（media_kind 独立授权）。
 */
const { cached } = require('./cache');

const REASONS = {
  ok: 'ok',
  film_hidden: 'film_hidden',
  version_not_found: 'version_not_found',
  not_published: 'not_published',
  not_approved: 'not_approved',
  scheduled_future: 'scheduled_future',
  no_license: 'no_license',
  license_not_started: 'license_not_started',
  license_expired: 'license_expired',
  license_terminated: 'license_terminated',
  territory_denied: 'territory_denied',
};

function minIso(list) {
  const valid = list.filter(Boolean);
  return valid.length ? valid.reduce((a, b) => (a < b ? a : b)) : null;
}

function territoryAllowed(territoriesJson, territory) {
  try {
    const list = JSON.parse(territoriesJson || '[]');
    return list.includes('WORLD') || list.includes(territory);
  } catch { return false; }
}

/**
 * 核心判定。返回 { allowed, reason, boundary }。
 * boundary = 未来最近的状态翻转时间点（供缓存 TTL 使用）。
 */
function evaluateAccess(db, { filmId, versionId = null, mediaKind, territory = 'WORLD', at = new Date() }) {
  const nowIso = at.toISOString();
  const boundaries = [];

  const film = db.get('SELECT * FROM films WHERE id = ?', [filmId]);
  if (!film || film.catalog_visibility !== 'public') {
    return { allowed: false, reason: REASONS.film_hidden, boundary: null };
  }

  // 1) 版本门控（版本绑定的媒介：预告/片段/完整片/字幕）
  if (versionId) {
    const v = db.get('SELECT * FROM versions WHERE id = ?', [versionId]);
    if (!v) return { allowed: false, reason: REASONS.version_not_found, boundary: null };
    if (v.status !== 'published') return { allowed: false, reason: REASONS.not_published, boundary: null };

    // 2) 发布清单门控：必须已批准；not_before 到达后才有资格（计算式定时上线）
    const rel = db.get(
      'SELECT * FROM release_list WHERE version_id = ? AND approved = 1 ORDER BY id DESC LIMIT 1',
      [versionId]
    );
    if (!rel) return { allowed: false, reason: REASONS.not_approved, boundary: null };
    if (rel.not_before && rel.not_before > nowIso) {
      return { allowed: false, reason: REASONS.scheduled_future, boundary: rel.not_before };
    }
  }

  // 3) 许可：影片级(version_id IS NULL)或绑定该版本；按媒介分别检查
  const licenses = db.all(
    `SELECT * FROM licenses
      WHERE film_id = ? AND media_kind = ?
        AND (version_id IS NULL OR version_id = ?)`,
    [filmId, mediaKind, versionId == null ? -1 : versionId]
  );

  let sawTerminated = false, sawExpired = false, sawTerritoryDeny = false, sawNotStarted = false;

  for (const lic of licenses) {
    if (lic.status === 'terminated') { sawTerminated = true; continue; }
    if (lic.start_at > nowIso) { sawNotStarted = true; boundaries.push(lic.start_at); continue; }
    if (lic.end_at && lic.end_at <= nowIso) { sawExpired = true; continue; }
    if (!territoryAllowed(lic.territories, territory)) { sawTerritoryDeny = true; continue; }
    // 命中有效许可
    if (lic.end_at) boundaries.push(lic.end_at);
    return { allowed: true, reason: REASONS.ok, boundary: minIso(boundaries), license_id: lic.id };
  }

  const reason =
    sawTerminated ? REASONS.license_terminated :
    sawExpired ? REASONS.license_expired :
    sawNotStarted ? REASONS.license_not_started :
    sawTerritoryDeny ? REASONS.territory_denied :
    REASONS.no_license;
  return { allowed: false, reason, boundary: minIso(boundaries) };
}

/** 带缓存的判定：键含 影片/版本/媒介/地域；变更时由 bumpEpoch 全局失效。 */
function evaluateAccessCached(db, args) {
  const key = `access:${args.filmId}:${args.versionId ?? '-'}:${args.mediaKind}:${args.territory || 'WORLD'}`;
  return cached(key, () => evaluateAccess(db, args));
}

/** 查询某版本某媒介的最新资产（字幕取最高修订号）。 */
function latestAsset(db, filmId, versionId, kind) {
  if (versionId) {
    return db.get(
      `SELECT * FROM assets WHERE film_id = ? AND version_id = ? AND kind = ?
        ORDER BY revision DESC, id DESC LIMIT 1`, [filmId, versionId, kind]);
  }
  return db.get(
    `SELECT * FROM assets WHERE film_id = ? AND version_id IS NULL AND kind = ?
      ORDER BY revision DESC, id DESC LIMIT 1`, [filmId, kind]);
}

module.exports = { evaluateAccess, evaluateAccessCached, latestAsset, REASONS };
