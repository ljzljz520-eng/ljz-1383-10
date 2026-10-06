'use strict';

/** 管理员令牌（可用环境变量 ADMIN_TOKENS_JSON 覆盖，格式 {"token":{"name":"..","roles":["admin"]}}） */
function loadAdmins() {
  if (process.env.ADMIN_TOKENS_JSON) {
    try { return JSON.parse(process.env.ADMIN_TOKENS_JSON); } catch { /* fall through */ }
  }
  return {
    'token-admin-a': { name: 'admin-a', roles: ['admin'] },
    'token-admin-b': { name: 'admin-b', roles: ['admin'] },
  };
}

const ADMINS = loadAdmins();

function requireAdmin(req, res, next) {
  const token = req.get('X-Admin-Token') || '';
  const admin = ADMINS[token];
  if (!admin) return res.status(401).json({ error: 'unauthorized', message: '需要有效的管理员令牌' });
  req.admin = admin;
  next();
}

module.exports = { requireAdmin, ADMINS };
