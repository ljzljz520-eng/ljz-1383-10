'use strict';
const fs = require('fs');
const path = require('path');
const initSqlJs = require('sql.js');

const SCHEMA = `
PRAGMA foreign_keys=ON;

CREATE TABLE IF NOT EXISTS films (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  original_title TEXT DEFAULT '',
  year INTEGER,
  director_name TEXT NOT NULL,
  synopsis TEXT DEFAULT '',
  fallback_text TEXT DEFAULT '',        -- 影片无法公开时展示的、经批准的文字说明
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS versions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  film_id INTEGER NOT NULL REFERENCES films(id),
  label TEXT NOT NULL,                  -- festival 影展版 | public 公开版 | director 导演版
  cut_note TEXT DEFAULT '',
  runtime_sec INTEGER DEFAULT 0,
  subtitle_revision INTEGER NOT NULL DEFAULT 1,  -- 字幕修订号
  slot TEXT,                            -- 发布槽位: web_public | festival_circuit
  status TEXT NOT NULL DEFAULT 'draft', -- draft|scheduled|published|archived|schedule_failed
  scheduled_publish_at TEXT,
  published_at TEXT,
  published_by TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS assets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  film_id INTEGER NOT NULL REFERENCES films(id),
  version_id INTEGER REFERENCES versions(id),   -- 海报/剧照为影片级(NULL)，预告/片段/正片/字幕绑定版本
  kind TEXT NOT NULL,                           -- poster|still|trailer|clip|full|subtitle
  storage_path TEXT NOT NULL,                   -- 仅内部使用，任何公开接口不得返回
  is_public_clip INTEGER NOT NULL DEFAULT 0,    -- 公开片段需管理员明确批准
  revision INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS screenings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  version_id INTEGER NOT NULL REFERENCES versions(id),  -- 绑定实际版本，绝不按片名合并
  festival_name TEXT DEFAULT '',
  venue TEXT NOT NULL,
  city TEXT DEFAULT '',
  country TEXT DEFAULT '',
  screened_at TEXT NOT NULL,
  notes TEXT DEFAULT '',
  created_by TEXT DEFAULT '',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS licenses (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  film_id INTEGER NOT NULL REFERENCES films(id),
  asset_kind TEXT NOT NULL,        -- poster|still|trailer|clip|full 分别授权、分别检查
  territory TEXT NOT NULL DEFAULT 'GLOBAL',  -- GLOBAL 或 ISO 地区码
  media TEXT NOT NULL DEFAULT 'web',         -- web|festival|broadcast|all
  starts_at TEXT NOT NULL,
  ends_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',     -- active|terminated
  terminated_at TEXT,
  created_by TEXT DEFAULT '',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS credits (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  film_id INTEGER NOT NULL REFERENCES films(id),
  person_name TEXT NOT NULL,
  role TEXT NOT NULL,                -- 按来源原文记录，不做任何自动升格
  verified INTEGER NOT NULL DEFAULT 0,
  source TEXT DEFAULT '',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS contacts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  category TEXT NOT NULL,            -- collaboration|screening|interview
  name TEXT NOT NULL,
  email TEXT NOT NULL,
  org TEXT DEFAULT '',
  message TEXT NOT NULL,
  routed_to TEXT NOT NULL,
  has_private_material INTEGER NOT NULL DEFAULT 0,
  private_material_path TEXT,        -- 私密材料，公开接口绝不返回
  status TEXT NOT NULL DEFAULT 'new',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS publish_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  version_id INTEGER NOT NULL REFERENCES versions(id),
  actor TEXT NOT NULL,
  action TEXT NOT NULL,              -- publish|schedule|unpublish|conflict_rejected|schedule_failed|auto_publish
  slot TEXT DEFAULT '',
  detail TEXT DEFAULT '',
  created_at TEXT NOT NULL
);
`;

async function createDatabase(dbPath) {
  const SQL = await initSqlJs();
  let raw;
  if (dbPath && dbPath !== ':memory:' && fs.existsSync(dbPath)) {
    raw = new SQL.Database(fs.readFileSync(dbPath));
  } else {
    raw = new SQL.Database();
  }
  raw.exec('PRAGMA foreign_keys=ON;');
  raw.exec(SCHEMA);

  let txDepth = 0; // sql.js 的 export() 会结束活动事务，事务内禁止 save()
  const api = {
    raw,
    all(sql, params = []) {
      const stmt = raw.prepare(sql);
      try {
        stmt.bind(params);
        const rows = [];
        while (stmt.step()) rows.push(stmt.getAsObject());
        return rows;
      } finally {
        stmt.free();
      }
    },
    get(sql, params = []) {
      return api.all(sql, params)[0] || null;
    },
    run(sql, params = []) {
      const stmt = raw.prepare(sql);
      try {
        stmt.bind(params);
        stmt.step();
      } finally {
        stmt.free();
      }
      const id = api.get('SELECT last_insert_rowid() AS id').id;
      if (txDepth === 0) api.save();
      return id;
    },
    tx(fn) {
      raw.exec('BEGIN IMMEDIATE');
      txDepth++;
      try {
        const out = fn();
        txDepth--;
        raw.exec('COMMIT');
        api.save();
        return out;
      } catch (e) {
        txDepth--;
        try { raw.exec('ROLLBACK'); } catch { /* 事务可能已结束，不掩盖原始错误 */ }
        throw e;
      }
    },
    save() {
      if (!dbPath || dbPath === ':memory:') return;
      fs.mkdirSync(path.dirname(dbPath), { recursive: true });
      fs.writeFileSync(dbPath, Buffer.from(raw.export()));
    },
    close() {
      api.save();
      raw.close();
    },
  };
  return api;
}

module.exports = { createDatabase };
