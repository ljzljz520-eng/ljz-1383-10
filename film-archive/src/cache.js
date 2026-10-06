'use strict';
/**
 * 可见性缓存：
 *  - 纪元(epoch)失效：任何许可/版本/发布清单/资产变更都会 bumpEpoch()，
 *    使全部缓存条目立即作废 —— 授权提前终止等变更即时生效。
 *  - 边界 TTL：条目过期时间取 min(30s, 距下一个状态翻转点)，
 *    翻转点包括 许可起止时间 与 定时上线 not_before，到点自动重算，
 *    不依赖 cron 主动刷新，避免定时任务与状态冲突。
 */
let epoch = 0;
const store = new Map();
const MAX_TTL_MS = 30_000;

function bumpEpoch() { epoch++; }
function getEpoch() { return epoch; }

function cached(key, compute) {
  const now = Date.now();
  const hit = store.get(key);
  if (hit && hit.epoch === epoch && hit.expiresAt > now) return hit.value;

  const value = compute();
  let ttl = MAX_TTL_MS;
  if (value && value.boundary) {
    const b = Date.parse(value.boundary);
    if (!Number.isNaN(b)) ttl = Math.min(ttl, Math.max(0, b - now));
  }
  if (ttl > 0) store.set(key, { value, expiresAt: now + ttl, epoch });
  return value;
}

// 定期清扫过期条目，防止无限增长
const sweeper = setInterval(() => {
  const now = Date.now();
  for (const [k, v] of store) if (v.expiresAt <= now) store.delete(k);
}, 60_000);
sweeper.unref();

module.exports = { cached, bumpEpoch, getEpoch, _store: store };
