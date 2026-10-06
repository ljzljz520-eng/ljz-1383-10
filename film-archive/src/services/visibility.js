'use strict';

/**
 * 可见性方案选型（对比两种方案后做出选择）：
 *
 * 方案A —— 按许可实时计算：以 licenses 表为准，按 (影片, 素材类型, 地域, 媒介, 当前时间)
 *   实时判定。优点：授权提前结束立即生效、语义单一权威；缺点：每次请求需计算。
 * 方案B —— 预先批准的发布清单：管理员批准静态清单，缓存友好、可审计；
 *   缺点：授权终止后清单不会自动失效，需要人工回收，存在越权窗口。
 *
 * 选择：以方案A（实时许可计算）为唯一权威来源，叠加短 TTL 缓存控制成本；
 * 缓存过期时间取 min(TTL, 最近一条许可的 ends_at / starts_at)，保证缓存绝不比许可活得更久；
 * 任何许可/版本/素材写操作触发按影片的主动失效，授权提前结束立即生效，无需等待 TTL。
 * 方案B 的"预先批准清单"保留为发布流程（publish slot + 定时上线），但它只决定
 * "哪个版本被推到公开槽位"，可见性仍由许可实时把关——两层互不替代。
 */
function createVisibilityService(db, opts = {}) {
  const now = opts.now || (() => new Date());
  const ttlMs = opts.ttlMs != null ? opts.ttlMs : 30_000;
  const cache = new Map();

  const keyOf = (filmId, kind, region, media) => `${filmId}|${kind}|${region}|${media}`;

  function compute(filmId, kind, region, media) {
    const t = now().toISOString();
    const tMs = now().getTime();
    const active = db.all(
      `SELECT ends_at FROM licenses
       WHERE film_id=? AND asset_kind=? AND status='active'
         AND (territory='GLOBAL' OR territory=?)
         AND (media='all' OR media=?)
         AND starts_at<=? AND ends_at>?
       ORDER BY ends_at ASC`,
      [filmId, kind, region, media, t, t]
    );
    if (active.length > 0) {
      // 缓存到期不超过最近一条许可的结束时间 —— 许可到期即缓存到期
      const expiry = Math.min(tMs + ttlMs, Date.parse(active[0].ends_at));
      return { value: true, expires: expiry };
    }
    // 否定结果同样不能久存：若有未来生效的许可，在其 starts_at 时唤醒重算
    const upcoming = db.get(
      `SELECT MIN(starts_at) AS s FROM licenses
       WHERE film_id=? AND asset_kind=? AND status='active'
         AND (territory='GLOBAL' OR territory=?)
         AND (media='all' OR media=?) AND starts_at>?`,
      [filmId, kind, region, media, t]
    );
    let expiry = tMs + ttlMs;
    if (upcoming && upcoming.s) expiry = Math.min(expiry, Date.parse(upcoming.s));
    return { value: false, expires: expiry };
  }

  return {
    /** 许可是否允许 (影片, 素材类型) 在指定地域与媒介下当前可见 */
    isLicensed(filmId, kind, region = 'GLOBAL', media = 'web') {
      const k = keyOf(filmId, kind, region, media);
      const hit = cache.get(k);
      if (hit && hit.expires > now().getTime()) return hit.value;
      const entry = compute(filmId, kind, region, media);
      cache.set(k, entry);
      return entry.value;
    },
    /** 许可/版本/素材变更后调用：主动失效，授权提前结束立即生效 */
    invalidate(filmId = null) {
      if (filmId == null) return cache.clear();
      for (const k of [...cache.keys()]) {
        if (k.startsWith(`${filmId}|`)) cache.delete(k);
      }
    },
    _entry(filmId, kind, region = 'GLOBAL', media = 'web') {
      return cache.get(keyOf(filmId, kind, region, media)) || null;
    },
    _size() { return cache.size; },
  };
}

module.exports = { createVisibilityService };
