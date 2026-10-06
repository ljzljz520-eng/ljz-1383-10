'use strict';
const fs = require('fs');
const path = require('path');
const { isoNow } = require('./util');

function svgPoster(title, subtitle, hue) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="400" height="560" viewBox="0 0 400 560">
  <rect width="400" height="560" fill="hsl(${hue},35%,12%)"/>
  <rect x="24" y="24" width="352" height="512" fill="none" stroke="hsl(${hue},60%,55%)" stroke-width="2"/>
  <text x="200" y="270" font-size="64" fill="hsl(${hue},70%,80%)" text-anchor="middle" font-family="serif">${title}</text>
  <text x="200" y="320" font-size="18" fill="hsl(${hue},40%,60%)" text-anchor="middle" font-family="sans-serif" letter-spacing="4">${subtitle}</text>
</svg>`;
}
function svgStill(title, hue, n) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="360" viewBox="0 0 640 360">
  <rect width="640" height="360" fill="hsl(${hue},30%,${14 + n * 4}%)"/>
  <circle cx="${120 + n * 160}" cy="180" r="70" fill="hsl(${hue},55%,45%)" opacity="0.7"/>
  <text x="320" y="330" font-size="20" fill="hsl(${hue},50%,75%)" text-anchor="middle" font-family="sans-serif">${title} · 剧照 ${n}</text>
</svg>`;
}

/** 演示数据：三位青年导演、多版本、分类型许可、影展放映记录、署名 */
function seedIfEmpty(db, storageDir) {
  if (db.get('SELECT COUNT(*) AS c FROM films').c > 0) return false;
  fs.mkdirSync(storageDir, { recursive: true });
  const now = isoNow();
  const put = (name, content) => { const p = path.join(storageDir, name); fs.writeFileSync(p, content); return p; };

  db.tx(() => {
    // —— 影片 1：《夜航》 ——
    const f1 = db.run(`INSERT INTO films (title, original_title, year, director_name, synopsis, fallback_text, created_at)
      VALUES ('夜航', 'Night Ferry', 2024, '林小满', '夜班渡轮上，两位陌生人在天亮前交换了彼此的秘密。', '本片完整版本暂仅限指定地区线上观看，其他地区观众可关注影展放映信息。', ?)`, [now]);
    const f1Fest = db.run(`INSERT INTO versions (film_id, label, cut_note, runtime_sec, slot, status, published_at, published_by, created_at, updated_at)
      VALUES (?, 'festival', '影展版 · 24分钟', 1440, 'festival_circuit', 'published', ?, 'admin-a', ?, ?)`, [f1, now, now, now]);
    const f1Pub = db.run(`INSERT INTO versions (film_id, label, cut_note, runtime_sec, slot, status, published_at, published_by, created_at, updated_at)
      VALUES (?, 'public', '公开版 · 22分钟（重剪结尾）', 1320, 'web_public', 'published', ?, 'admin-a', ?, ?)`, [f1, now, now, now]);
    db.run(`INSERT INTO versions (film_id, label, cut_note, runtime_sec, status, created_at, updated_at)
      VALUES (?, 'director', '导演剪辑版 · 31分钟（未完成混音）', 1860, 'draft', ?, ?)`, [f1, now, now]);
    db.run(`INSERT INTO assets (film_id, version_id, kind, storage_path, created_at) VALUES (?, NULL, 'poster', ?, ?)`, [f1, put('f1-poster.svg', svgPoster('夜航', 'NIGHT FERRY', 220)), now]);
    db.run(`INSERT INTO assets (film_id, version_id, kind, storage_path, created_at) VALUES (?, NULL, 'still', ?, ?)`, [f1, put('f1-still-1.svg', svgStill('夜航', 220, 1)), now]);
    db.run(`INSERT INTO assets (film_id, version_id, kind, storage_path, created_at) VALUES (?, NULL, 'still', ?, ?)`, [f1, put('f1-still-2.svg', svgStill('夜航', 220, 2)), now]);
    db.run(`INSERT INTO assets (film_id, version_id, kind, storage_path, created_at) VALUES (?, ?, 'trailer', ?, ?)`, [f1, f1Pub, put('f1-trailer.bin', 'TRAILER DATA'), now]);
    db.run(`INSERT INTO assets (film_id, version_id, kind, storage_path, is_public_clip, created_at) VALUES (?, ?, 'clip', ?, 1, ?)`, [f1, f1Pub, put('f1-clip.bin', 'PUBLIC CLIP DATA'), now]);
    db.run(`INSERT INTO assets (film_id, version_id, kind, storage_path, created_at) VALUES (?, ?, 'full', ?, ?)`, [f1, f1Pub, put('f1-full.bin', 'FULL FILM DATA (public cut)'), now]);
    db.run(`INSERT INTO assets (film_id, version_id, kind, storage_path, created_at) VALUES (?, ?, 'full', ?, ?)`, [f1, f1Fest, put('f1-full-fest.bin', 'FULL FILM DATA (festival cut)'), now]);
    // 许可：海报/剧照/预告/片段全球；完整影片仅中国大陆、web、2025-2026
    for (const kind of ['poster', 'still', 'trailer', 'clip']) {
      db.run(`INSERT INTO licenses (film_id, asset_kind, territory, media, starts_at, ends_at, status, created_by, created_at)
        VALUES (?, ?, 'GLOBAL', 'web', '2024-01-01T00:00:00.000Z', '2027-12-31T23:59:59.000Z', 'active', 'admin-a', ?)`, [f1, kind, now]);
    }
    db.run(`INSERT INTO licenses (film_id, asset_kind, territory, media, starts_at, ends_at, status, created_by, created_at)
      VALUES (?, 'full', 'CN', 'web', '2025-01-01T00:00:00.000Z', '2026-12-31T23:59:59.000Z', 'active', 'admin-a', ?)`, [f1, now]);
    // 放映记录绑定影展版
    db.run(`INSERT INTO screenings (version_id, festival_name, venue, city, country, screened_at, notes, created_by, created_at)
      VALUES (?, 'FIRST青年电影展', '西宁·青海大剧院', '西宁', 'CN', '2024-07-25T12:00:00.000Z', '世界首映', 'admin-a', ?)`, [f1Fest, now]);
    db.run(`INSERT INTO screenings (version_id, festival_name, venue, city, country, screened_at, notes, created_by, created_at)
      VALUES (?, '北京独立影像展', '北京·尤伦斯当代艺术中心', '北京', 'CN', '2024-09-14T13:00:00.000Z', '', 'admin-a', ?)`, [f1Fest, now]);
    db.run(`INSERT INTO screenings (version_id, festival_name, venue, city, country, screened_at, notes, created_by, created_at)
      VALUES (?, '高校巡展', '上海大学延长校区', '上海', 'CN', '2025-04-02T11:00:00.000Z', '公开版首次放映', 'admin-a', ?)`, [f1Pub, now]);
    // 署名：原文记录 + 可核实标记
    db.run(`INSERT INTO credits (film_id, person_name, role, verified, source, created_at) VALUES (?, '林小满', '导演 / 编剧', 1, 'FIRST青年电影展2024场刊', ?)`, [f1, now]);
    db.run(`INSERT INTO credits (film_id, person_name, role, verified, source, created_at) VALUES (?, '周岩', '摄影指导', 1, 'FIRST青年电影展2024场刊', ?)`, [f1, now]);
    db.run(`INSERT INTO credits (film_id, person_name, role, verified, source, created_at) VALUES (?, '阿灿', '实习场记', 0, '剧组口述，待核实', ?)`, [f1, now]);

    // —— 影片 2：《潮湿的信》（授权已提前结束的示例） ——
    const f2 = db.run(`INSERT INTO films (title, original_title, year, director_name, synopsis, fallback_text, created_at)
      VALUES ('潮湿的信', 'Letters in the Rain', 2023, '陈禾', '梅雨季里，一封封无法投递的信被退回旧公寓。', '应版权方要求，本片线上放映授权已提前结束。如需组织放映，请通过"放映"通道联系策展组。', ?)`, [now]);
    const f2Fest = db.run(`INSERT INTO versions (film_id, label, cut_note, runtime_sec, slot, status, published_at, published_by, created_at, updated_at)
      VALUES (?, 'festival', '影展版 · 18分钟', 1080, 'festival_circuit', 'published', ?, 'admin-b', ?, ?)`, [f2, now, now, now]);
    const f2Pub = db.run(`INSERT INTO versions (film_id, label, cut_note, runtime_sec, slot, status, published_at, published_by, created_at, updated_at)
      VALUES (?, 'public', '公开版 · 18分钟', 1080, 'web_public', 'published', ?, 'admin-b', ?, ?)`, [f2, now, now, now]);
    db.run(`INSERT INTO assets (film_id, version_id, kind, storage_path, created_at) VALUES (?, NULL, 'poster', ?, ?)`, [f2, put('f2-poster.svg', svgPoster('潮湿的信', 'LETTERS IN THE RAIN', 160)), now]);
    db.run(`INSERT INTO assets (film_id, version_id, kind, storage_path, created_at) VALUES (?, NULL, 'still', ?, ?)`, [f2, put('f2-still-1.svg', svgStill('潮湿的信', 160, 1)), now]);
    db.run(`INSERT INTO assets (film_id, version_id, kind, storage_path, created_at) VALUES (?, ?, 'trailer', ?, ?)`, [f2, f2Pub, put('f2-trailer.bin', 'TRAILER DATA'), now]);
    db.run(`INSERT INTO assets (film_id, version_id, kind, storage_path, created_at) VALUES (?, ?, 'full', ?, ?)`, [f2, f2Pub, put('f2-full.bin', 'FULL FILM DATA'), now]);
    for (const kind of ['poster', 'still', 'trailer']) {
      db.run(`INSERT INTO licenses (film_id, asset_kind, territory, media, starts_at, ends_at, status, created_by, created_at)
        VALUES (?, ?, 'GLOBAL', 'web', '2023-06-01T00:00:00.000Z', '2027-05-31T23:59:59.000Z', 'active', 'admin-b', ?)`, [f2, kind, now]);
    }
    // 完整影片许可原至 2026 年，2025-08 被提前终止
    db.run(`INSERT INTO licenses (film_id, asset_kind, territory, media, starts_at, ends_at, status, terminated_at, created_by, created_at)
      VALUES (?, 'full', 'GLOBAL', 'web', '2023-06-01T00:00:00.000Z', '2026-05-31T23:59:59.000Z', 'terminated', '2025-08-01T00:00:00.000Z', 'admin-b', ?)`, [f2, now]);
    db.run(`INSERT INTO screenings (version_id, festival_name, venue, city, country, screened_at, notes, created_by, created_at)
      VALUES (?, '平遥国际电影展', '平遥电影宫', '晋中', 'CN', '2023-10-15T12:00:00.000Z', '藏龙单元', 'admin-b', ?)`, [f2Fest, now]);
    db.run(`INSERT INTO credits (film_id, person_name, role, verified, source, created_at) VALUES (?, '陈禾', '导演', 1, '平遥国际电影展2023节目册', ?)`, [f2, now]);

    // —— 影片 3：《夏日录音》（新片，仅海报剧照可公开） ——
    const f3 = db.run(`INSERT INTO films (title, original_title, year, director_name, synopsis, fallback_text, created_at)
      VALUES ('夏日录音', 'Summer Tapes', 2025, '阿依努尔·买买提', '用一台旧录音机收集小镇夏天最后的声音。', '本片正在后期制作与影展投递阶段，暂不提供线上公开内容。', ?)`, [now]);
    const f3Dir = db.run(`INSERT INTO versions (film_id, label, cut_note, runtime_sec, status, created_at, updated_at)
      VALUES (?, 'director', '导演版 · 工作样片', 1500, 'draft', ?, ?)`, [f3, now, now]);
    db.run(`INSERT INTO assets (film_id, version_id, kind, storage_path, created_at) VALUES (?, NULL, 'poster', ?, ?)`, [f3, put('f3-poster.svg', svgPoster('夏日录音', 'SUMMER TAPES', 40)), now]);
    db.run(`INSERT INTO assets (film_id, version_id, kind, storage_path, created_at) VALUES (?, NULL, 'still', ?, ?)`, [f3, put('f3-still-1.svg', svgStill('夏日录音', 40, 1)), now]);
    db.run(`INSERT INTO assets (film_id, version_id, kind, storage_path, created_at) VALUES (?, ?, 'full', ?, ?)`, [f3, f3Dir, put('f3-full.bin', 'WORK IN PROGRESS'), now]);
    for (const kind of ['poster', 'still']) {
      db.run(`INSERT INTO licenses (film_id, asset_kind, territory, media, starts_at, ends_at, status, created_by, created_at)
        VALUES (?, ?, 'GLOBAL', 'web', '2025-01-01T00:00:00.000Z', '2028-12-31T23:59:59.000Z', 'active', 'admin-a', ?)`, [f3, kind, now]);
    }
    db.run(`INSERT INTO credits (film_id, person_name, role, verified, source, created_at) VALUES (?, '阿依努尔·买买提', '导演 / 录音', 1, '导演本人确认', ?)`, [f3, now]);
  });
  return true;
}

module.exports = { seedIfEmpty };
