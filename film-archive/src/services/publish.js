'use strict';
const { httpError } = require('../util');

/**
 * 发布服务：同一影片同一发布槽位(slot)同一时刻只允许一个已发布版本。
 * - 即时发布：槽位被占用时返回 409（除非 force=true 显式替换，旧版本归档）。
 * - 定时上线：排期时预检冲突（与已发布/已排期版本冲突即 409，避免定时上线撞车）；
 *   到点执行时复查，若期间槽位被抢占则标记 schedule_failed 并写审计事件，绝不静默覆盖。
 */
function createPublishService(db, vis, opts = {}) {
  const now = opts.now || (() => new Date());

  function logEvent(versionId, actor, action, slot, detail) {
    db.run(
      `INSERT INTO publish_events (version_id, actor, action, slot, detail, created_at)
       VALUES (?,?,?,?,?,?)`,
      [versionId, actor, action, slot || '', detail || '', now().toISOString()]
    );
  }

  function publish({ versionId, actor, slot = 'web_public', scheduledAt = null, force = false }) {
    // 冲突审计必须在事务外记录：事务内的日志会随 409 回滚一起消失
    let rejected = null;
    try {
      return db.tx(() => {
        const v = db.get('SELECT * FROM versions WHERE id=?', [versionId]);
        if (!v) throw httpError(404, 'version_not_found');
        const t = now().toISOString();

        // —— 定时上线分支 ——
        if (scheduledAt && Date.parse(scheduledAt) > now().getTime()) {
          const conflict = db.get(
            `SELECT id FROM versions
             WHERE film_id=? AND slot=? AND id<>? AND status IN ('published','scheduled')`,
            [v.film_id, slot, versionId]
          );
          if (conflict && !force) {
            rejected = { with: conflict.id, note: `排期与版本 #${conflict.id} 冲突` };
            throw httpError(409, 'publish_conflict', { conflict_with: conflict.id });
          }
          if (conflict && force) {
            db.run(`UPDATE versions SET status='draft', scheduled_publish_at=NULL, updated_at=? WHERE id=?`, [t, conflict.id]);
            logEvent(conflict.id, actor, 'unpublish', slot, `被版本 #${versionId} 的排期强制替换`);
          }
          db.run(
            `UPDATE versions SET status='scheduled', scheduled_publish_at=?, slot=?, updated_at=? WHERE id=?`,
            [scheduledAt, slot, t, versionId]
          );
          logEvent(versionId, actor, 'schedule', slot, `定于 ${scheduledAt} 上线`);
          vis.invalidate(v.film_id);
          return { state: 'scheduled', scheduled_at: scheduledAt };
        }

        // —— 即时发布分支 ——
        const conflict = db.get(
          `SELECT id, published_by FROM versions
           WHERE film_id=? AND slot=? AND status='published' AND id<>?`,
          [v.film_id, slot, versionId]
        );
        if (conflict && !force) {
          rejected = { with: conflict.id, note: `与版本 #${conflict.id}(${conflict.published_by}) 冲突` };
          throw httpError(409, 'publish_conflict', { conflict_with: conflict.id, published_by: conflict.published_by });
        }
        if (conflict) {
          db.run(`UPDATE versions SET status='archived', updated_at=? WHERE id=?`, [t, conflict.id]);
          logEvent(conflict.id, actor, 'unpublish', slot, `被版本 #${versionId} 强制替换归档`);
        }
        db.run(
          `UPDATE versions SET status='published', slot=?, published_at=?, published_by=?,
             scheduled_publish_at=NULL, updated_at=? WHERE id=?`,
          [slot, t, actor, t, versionId]
        );
        logEvent(versionId, actor, 'publish', slot, force && conflict ? `强制替换版本 #${conflict.id}` : '');
        vis.invalidate(v.film_id);
        return { state: 'published', published_at: t, replaced: conflict ? conflict.id : null };
      });
    } catch (e) {
      if (e.status === 409 && rejected) {
        logEvent(versionId, actor, 'conflict_rejected', slot, rejected.note);
      }
      throw e;
    }
  }

  function unpublish(versionId, actor) {
    return db.tx(() => {
      const v = db.get('SELECT * FROM versions WHERE id=?', [versionId]);
      if (!v) throw httpError(404, 'version_not_found');
      db.run(`UPDATE versions SET status='archived', updated_at=? WHERE id=?`, [now().toISOString(), versionId]);
      logEvent(versionId, actor, 'unpublish', v.slot || '', '');
      vis.invalidate(v.film_id);
      return { state: 'archived' };
    });
  }

  /** 到点执行定时上线；冲突时标记失败而不覆盖他人发布 */
  function runDue() {
    const due = db.all(
      `SELECT * FROM versions WHERE status='scheduled' AND scheduled_publish_at<=?`,
      [now().toISOString()]
    );
    const results = [];
    for (const v of due) {
      try {
        const r = publish({ versionId: v.id, actor: 'scheduler', slot: v.slot || 'web_public' });
        logEvent(v.id, 'scheduler', 'auto_publish', v.slot || '', '');
        results.push({ version: v.id, ...r });
      } catch (e) {
        if (e.status === 409) {
          db.run(`UPDATE versions SET status='schedule_failed', updated_at=? WHERE id=?`, [now().toISOString(), v.id]);
          logEvent(v.id, 'scheduler', 'schedule_failed', v.slot || '', `定时上线冲突：${JSON.stringify(e.details || {})}`);
          results.push({ version: v.id, state: 'schedule_failed' });
        } else {
          throw e;
        }
      }
    }
    return results;
  }

  return { publish, unpublish, runDue };
}

module.exports = { createPublishService };
