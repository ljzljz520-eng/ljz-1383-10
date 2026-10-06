'use strict';
/**
 * 数据库层：sql.js (SQLite WASM)，事务 + 文件持久化。
 * 测试可用 inMemory 模式。
 */
const initSqlJs = require('sql.js');
const fs = require('fs');
const path = require('path');

const DEFAULT_DB_PATH = path.join(__dirname, '..', 'data', 'archive.db');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS films (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  original_title TEXT,
  year INTEGER,
  synopsis TEXT,
  fallback_text TEXT,                 -- 无法公开时展示的“经批准的文字说明”
  fallback_approved INTEGER NOT NULL DEFAULT 0,
  catalog_visibility TEXT NOT NULL DEFAULT 'public',  -- public / hidden
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- 署名职责：仅记录可核实的原始职责，绝不做“升级式”聚合
CREATE TABLE IF NOT EXISTS credits (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  film_id INTEGER NOT NULL REFERENCES films(id),
  person_name TEXT NOT NULL,
  role TEXT NOT NULL,                 -- 原始职责，如 “摄影助理”，不得自动改写为 “摄影指导”
  verified INTEGER NOT NULL DEFAULT 0,
  source TEXT,                        -- 核实来源：片尾字幕 / 场刊 / 合同
  UNIQUE(film_id, person_name, role)
);

-- 剪辑版本：影展版 festival / 公开版 public / 导演版 director
CREATE TABLE IF NOT EXISTS versions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  film_id INTEGER NOT NULL REFERENCES films(id),
  label TEXT NOT NULL CHECK (label IN ('festival','public','director')),
  cut_note TEXT,
  runtime_sec INTEGER,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','published','archived')),
  seq INTEGER NOT NULL DEFAULT 1,
  created_by TEXT,
  published_by TEXT,
  published_at TEXT,
  UNIQUE(film_id, label, seq)
);
-- 同一影片同一时刻至多一个已发布版本 —— 解决两名管理员并发发布不同剪辑
CREATE UNIQUE INDEX IF NOT EXISTS one_published_version_per_film
  ON versions(film_id) WHERE status = 'published';

-- 资产：海报/剧照/预告/公开片段/完整影片/字幕（字幕带修订号）
CREATE TABLE IF NOT EXISTS assets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  film_id INTEGER NOT NULL REFERENCES films(id),
  version_id INTEGER REFERENCES versions(id),   -- 预告/片段/完整片/字幕绑定版本；海报剧照为影片级
  kind TEXT NOT NULL CHECK (kind IN ('poster','still','trailer','clip','full_film','subtitle')),
  revision INTEGER NOT NULL DEFAULT 1,
  storage_path TEXT NOT NULL,                    -- 内部路径，任何公开接口不得返回
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- 许可：按媒介分别授权，含地域与时段；可提前终止
CREATE TABLE IF NOT EXISTS licenses (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  film_id INTEGER NOT NULL REFERENCES films(id),
  version_id INTEGER REFERENCES versions(id),    -- NULL = 影片级（海报/剧照等）
  media_kind TEXT NOT NULL CHECK (media_kind IN ('poster','still','trailer','clip','full_film','subtitle')),
  territories TEXT NOT NULL DEFAULT '["WORLD"]', -- JSON 数组，WORLD 为全球
  start_at TEXT NOT NULL,
  end_at TEXT,                                   -- NULL = 无固定截止
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','terminated')),
  terminated_at TEXT,
  termination_reason TEXT,
  approved_by TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- 预先批准的发布清单：作为门控条件（非可见性真源）；not_before 实现定时上线
CREATE TABLE IF NOT EXISTS release_list (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  version_id INTEGER NOT NULL REFERENCES versions(id),
  approved INTEGER NOT NULL DEFAULT 0,
  approved_by TEXT,
  not_before TEXT,                               -- 到达该时间后才“有资格”可见
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- 放映记录：必须绑定具体版本，禁止只按片名合并
CREATE TABLE IF NOT EXISTS screenings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  film_id INTEGER NOT NULL REFERENCES films(id),
  version_id INTEGER NOT NULL REFERENCES versions(id),
  event_name TEXT,
  venue TEXT,
  city TEXT,
  country TEXT,
  screened_at TEXT NOT NULL,
  source TEXT,                                   -- 补录来源
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- 联系表单：按 合作/放映/采访 分流；私密材料仅管理员队列可见
CREATE TABLE IF NOT EXISTS contact_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  category TEXT NOT NULL CHECK (category IN ('cooperation','screening','interview')),
  name TEXT NOT NULL,
  email TEXT NOT NULL,
  org TEXT,
  message TEXT NOT NULL,
  private_material TEXT,                         -- 私密材料，公开接口永不返回
  status TEXT NOT NULL DEFAULT 'new',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- 下载令牌：短时效；流式接口在下载开始时复核许可（权限变更即时生效）
CREATE TABLE IF NOT EXISTS download_tokens (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  token TEXT NOT NULL UNIQUE,
  asset_id INTEGER NOT NULL REFERENCES assets(id),
  territory TEXT,
  expires_at TEXT NOT NULL,
  revoked INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  actor TEXT,
  action TEXT,
  entity TEXT,
  entity_id INTEGER,
  payload TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
`;

async function initDb(options = {}) {
  const { dbPath = DEFAULT_DB_PATH, inMemory = false } = options;
  const SQL = await initSqlJs();
  let db;
  if (!inMemory && fs.existsSync(dbPath)) {
    db = new SQL.Database(fs.readFileSync(dbPath));
  } else {
    db = new SQL.Database();
  }
  db.run('PRAGMA foreign_keys = ON;');
  db.run(SCHEMA);

  function persist() {
    if (inMemory) return;
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    fs.writeFileSync(dbPath, Buffer.from(db.export()));
  }

  const api = {
    inMemory,
    run(sql, params = []) { db.run(sql, params); persist(); },
    get(sql, params = []) {
      const stmt = db.prepare(sql);
      try { stmt.bind(params); return stmt.step() ? stmt.getAsObject() : undefined; }
      finally { stmt.free(); }
    },
    all(sql, params = []) {
      const stmt = db.prepare(sql);
      const rows = [];
      try { stmt.bind(params); while (stmt.step()) rows.push(stmt.getAsObject()); }
      finally { stmt.free(); }
      return rows;
    },
    insert(sql, params = []) {
      db.run(sql, params);
      const id = api.get('SELECT last_insert_rowid() AS id').id;
      persist();
      return id;
    },
    /** 事务：多步写入原子提交；失败回滚。 */
    tx(fn) {
      db.run('BEGIN IMMEDIATE;');
      try {
        const result = fn(api);
        db.run('COMMIT;');
        persist();
        return result;
      } catch (err) {
        db.run('ROLLBACK;');
        throw err;
      }
    },
    persist,
  };
  return api;
}

module.exports = { initDb };
