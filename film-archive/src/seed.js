'use strict';
/** 演示数据：三部影片覆盖 影展版/公开版/导演版、分媒介许可、放映记录绑定版本等场景 */
const fs = require('fs');
const path = require('path');
const { initDb } = require('./db');

const MEDIA_DIR = path.join(__dirname, '..', 'data', 'media');

function writeMedia(name, content) {
  fs.mkdirSync(MEDIA_DIR, { recursive: true });
  fs.writeFileSync(path.join(MEDIA_DIR, name), content);
  return path.join('data', 'media', name);
}
const svg = (label, c1, c2) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="400" height="560"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${c1}"/><stop offset="1" stop-color="${c2}"/></linearGradient></defs><rect width="400" height="560" fill="url(#g)"/><text x="200" y="290" font-size="42" fill="#fff" text-anchor="middle" font-family="serif">${label}</text></svg>`;

async function seed() {
  const db = await initDb({ dbPath: process.env.DB_PATH || undefined });
  if (db.get('SELECT COUNT(*) AS c FROM films').c > 0) { console.log('已有数据，跳过种子'); return; }
  const now = Date.now();
  const iso = (t) => new Date(t).toISOString();
  const past = iso(now - 30 * 864e5), future = iso(now + 365 * 864e5), expired = iso(now - 864e5);

  // 影片一：《河岸》——公开版已发布，完整片仅中国大陆可看
  const f1 = db.insert(`INSERT INTO films(title,original_title,year,synopsis,fallback_text,fallback_approved)
    VALUES ('河岸','The Riverbank',2024,'小镇少年在汛期前的最后一个夏天。','本片完整版因地区授权限制暂不提供在线观看，可联系放映合作。',1)`);
  const f1fest = db.insert(`INSERT INTO versions(film_id,label,cut_note,runtime_sec,status,seq,created_by) VALUES (?,'festival','影展版：保留长镜头结尾',780,'archived',1,'admin-a')`, [f1]);
  const f1pub = db.insert(`INSERT INTO versions(film_id,label,cut_note,runtime_sec,status,seq,created_by,published_by,published_at)
    VALUES (?,'public','公开版：重新混音',720,'published',1,'admin-a','admin-a',?)`, [f1, iso(now - 10 * 864e5)]);
  db.insert(`INSERT INTO versions(film_id,label,cut_note,runtime_sec,status,seq,created_by) VALUES (?,'director','导演版：黑白调色',812,'draft',1,'admin-b')`, [f1]);
  db.insert('INSERT INTO release_list(version_id,approved,approved_by) VALUES (?,1,?)', [f1pub, 'admin-a']);
  db.insert(`INSERT INTO credits(film_id,person_name,role,verified,source) VALUES (?,'林澈','导演',1,'片尾字幕')`, [f1]);
  db.insert(`INSERT INTO credits(film_id,person_name,role,verified,source) VALUES (?,'周雨','摄影助理',1,'场刊核对')`, [f1]);
  db.insert(`INSERT INTO credits(film_id,person_name,role,verified,source) VALUES (?,'匿名投稿','联合编剧',0,NULL)`, [f1]);
  // 许可：海报/剧照全球永久；预告全球；完整片仅 CN；片段全球
  db.insert(`INSERT INTO licenses(film_id,media_kind,territories,start_at,approved_by) VALUES (?,'poster','["WORLD"]',?,'admin-a')`, [f1, past]);
  db.insert(`INSERT INTO licenses(film_id,media_kind,territories,start_at,approved_by) VALUES (?,'still','["WORLD"]',?,'admin-a')`, [f1, past]);
  db.insert(`INSERT INTO licenses(film_id,version_id,media_kind,territories,start_at,approved_by) VALUES (?,?,'trailer','["WORLD"]',?,'admin-a')`, [f1, f1pub, past]);
  db.insert(`INSERT INTO licenses(film_id,version_id,media_kind,territories,start_at,end_at,approved_by) VALUES (?,?,'full_film','["CN"]',?,?,'admin-a')`, [f1, f1pub, past, future]);
  db.insert(`INSERT INTO licenses(film_id,version_id,media_kind,territories,start_at,approved_by) VALUES (?,?,'clip','["WORLD"]',?,'admin-a')`, [f1, f1pub, past]);
  db.insert(`INSERT INTO licenses(film_id,version_id,media_kind,territories,start_at,approved_by) VALUES (?,?,'subtitle','["WORLD"]',?,'admin-a')`, [f1, f1pub, past]);
  // 资产
  db.insert(`INSERT INTO assets(film_id,kind,storage_path) VALUES (?,'poster',?)`, [f1, writeMedia('f1-poster.svg', svg('河岸', '#1e3a5f', '#3d6b99'))]);
  db.insert(`INSERT INTO assets(film_id,kind,storage_path) VALUES (?,'still',?)`, [f1, writeMedia('f1-still.svg', svg('河岸·剧照', '#2d4a3e', '#5a8a6e'))]);
  db.insert(`INSERT INTO assets(film_id,version_id,kind,storage_path) VALUES (?,?,'trailer',?)`, [f1, f1pub, writeMedia('f1-trailer.mp4', 'FAKE-MP4-TRAILER')]);
  db.insert(`INSERT INTO assets(film_id,version_id,kind,storage_path) VALUES (?,?,'clip',?)`, [f1, f1pub, writeMedia('f1-clip.mp4', 'FAKE-MP4-CLIP')]);
  db.insert(`INSERT INTO assets(film_id,version_id,kind,storage_path) VALUES (?,?,'full_film',?)`, [f1, f1pub, writeMedia('f1-full.mp4', 'FAKE-MP4-FULL')]);
  db.insert(`INSERT INTO assets(film_id,version_id,kind,revision,storage_path) VALUES (?,?,'subtitle',1,?)`, [f1, f1pub, writeMedia('f1-sub-v1.srt', '1\n00:00:01,000 --> 00:00:03,000\n河岸（修订1）\n')]);
  // 放映记录：绑定不同版本
  db.insert(`INSERT INTO screenings(film_id,version_id,event_name,venue,city,country,screened_at,source) VALUES (?,?,'平遥国际电影展','平遥电影宫','晋中','CN',?,'影展官网记录')`, [f1, f1fest, iso(now - 200 * 864e5)]);
  db.insert(`INSERT INTO screenings(film_id,version_id,event_name,venue,city,country,screened_at,source) VALUES (?,?,'线上公开放映','流媒体平台','线上','CN',?,'平台排期表')`, [f1, f1pub, iso(now - 9 * 864e5)]);

  // 影片二：《夜班地铁》——完整片许可已过期，展示经批准的文字说明
  const f2 = db.insert(`INSERT INTO films(title,original_title,year,synopsis,fallback_text,fallback_approved)
    VALUES ('夜班地铁','Night Metro',2022,'末班地铁上五位陌生人的一夜。','本片在线授权已于 2025 年到期，完整版暂不可公开观看；剧照与预告仍可浏览。',1)`);
  const f2pub = db.insert(`INSERT INTO versions(film_id,label,cut_note,runtime_sec,status,seq,created_by,published_by,published_at)
    VALUES (?,'public','公开版',660,'published',1,'admin-a','admin-a',?)`, [f2, iso(now - 400 * 864e5)]);
  db.insert('INSERT INTO release_list(version_id,approved,approved_by) VALUES (?,1,?)', [f2pub, 'admin-a']);
  db.insert(`INSERT INTO credits(film_id,person_name,role,verified,source) VALUES (?,'陈默','导演',1,'片尾字幕')`, [f2]);
  db.insert(`INSERT INTO licenses(film_id,media_kind,territories,start_at,approved_by) VALUES (?,'poster','["WORLD"]',?,'admin-a')`, [f2, past]);
  db.insert(`INSERT INTO licenses(film_id,version_id,media_kind,territories,start_at,approved_by) VALUES (?,?,'trailer','["WORLD"]',?,'admin-a')`, [f2, f2pub, past]);
  db.insert(`INSERT INTO licenses(film_id,version_id,media_kind,territories,start_at,end_at,approved_by) VALUES (?,?,'full_film','["WORLD"]',?,?,'admin-a')`, [f2, f2pub, iso(now - 400 * 864e5), expired]);
  db.insert(`INSERT INTO assets(film_id,kind,storage_path) VALUES (?,'poster',?)`, [f2, writeMedia('f2-poster.svg', svg('夜班地铁', '#3a1e3f', '#7a4a8a'))]);
  db.insert(`INSERT INTO assets(film_id,version_id,kind,storage_path) VALUES (?,?,'trailer',?)`, [f2, f2pub, writeMedia('f2-trailer.mp4', 'FAKE-MP4-TRAILER')]);
  db.insert(`INSERT INTO assets(film_id,version_id,kind,storage_path) VALUES (?,?,'full_film',?)`, [f2, f2pub, writeMedia('f2-full.mp4', 'FAKE-MP4-FULL')]);
  db.insert(`INSERT INTO screenings(film_id,version_id,event_name,venue,city,country,screened_at,source) VALUES (?,?,'FIRST 青年电影展','西宁','西宁','CN',?,'影展手册')`, [f2, f2pub, iso(now - 380 * 864e5)]);

  // 影片三：《风筝邮局》——定时上线（not_before 在未来），展示定时上线门控
  const f3 = db.insert(`INSERT INTO films(title,original_title,year,synopsis,fallback_text,fallback_approved)
    VALUES ('风筝邮局','Kite Post Office',2025,'海岛邮差与一只断线风筝。','本片将于近期上线，敬请期待。',1)`);
  const f3pub = db.insert(`INSERT INTO versions(film_id,label,cut_note,runtime_sec,status,seq,created_by,published_by,published_at)
    VALUES (?,'public','公开版',540,'published',1,'admin-b','admin-b',?)`, [f3, iso(now - 864e5)]);
  db.insert('INSERT INTO release_list(version_id,approved,approved_by,not_before) VALUES (?,1,?,?)', [f3pub, 'admin-b', iso(now + 7 * 864e5)]);
  db.insert(`INSERT INTO credits(film_id,person_name,role,verified,source) VALUES (?,'阿禾','导演',1,'片尾字幕')`, [f3]);
  db.insert(`INSERT INTO licenses(film_id,media_kind,territories,start_at,approved_by) VALUES (?,'poster','["WORLD"]',?,'admin-b')`, [f3, past]);
  db.insert(`INSERT INTO licenses(film_id,version_id,media_kind,territories,start_at,end_at,approved_by) VALUES (?,?,'full_film','["WORLD"]',?,?,'admin-b')`, [f3, f3pub, past, future]);
  db.insert(`INSERT INTO assets(film_id,kind,storage_path) VALUES (?,'poster',?)`, [f3, writeMedia('f3-poster.svg', svg('风筝邮局', '#8a5a2d', '#c98a4a'))]);
  db.insert(`INSERT INTO assets(film_id,version_id,kind,storage_path) VALUES (?,?,'full_film',?)`, [f3, f3pub, writeMedia('f3-full.mp4', 'FAKE-MP4-FULL')]);

  console.log('种子数据完成：3 部影片 / 多版本 / 分媒介许可 / 放映记录');
}

if (require.main === module) seed().catch((e) => { console.error(e); process.exit(1); });
module.exports = { seed };
