'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createApp } = require('../src/app');

const ADMIN_A = { 'X-Admin-Token': 'token-admin-a', 'Content-Type': 'application/json' };
const ADMIN_B = { 'X-Admin-Token': 'token-admin-b', 'Content-Type': 'application/json' };

let server, base, db, vis, tmp;

before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'archive-test-'));
  const storage = path.join(tmp, 'storage');
  fs.mkdirSync(storage, { recursive: true });
  fs.writeFileSync(path.join(storage, 'full.bin'), 'FULL DATA');
  fs.writeFileSync(path.join(storage, 'full2.bin'), 'FULL DATA 2');
  fs.writeFileSync(path.join(storage, 'trailer.bin'), 'TRAILER');
  fs.writeFileSync(path.join(storage, 'poster.svg'), '<svg/>');
  const r = await createApp({ dbPath: ':memory:', privateDir: path.join(tmp, 'private'), ttlMs: 60_000 });
  server = r.app.listen(0);
  db = r.db; vis = r.vis;
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => { server.close(); db.close(); fs.rmSync(tmp, { recursive: true, force: true }); });

const j = (res) => res.json();
const post = (url, body, headers = ADMIN_A) =>
  fetch(base + url, { method: 'POST', headers, body: JSON.stringify(body) });

/** 建一部带两个剪辑版本 + 完整影片许可的影片，返回各 id */
async function makeFilmWithTwoCuts() {
  const filmId = await post('/api/admin/films', { title: '测试片', director_name: '测试导演', fallback_text: '本片暂不可公开。' }).then(j).then(r => r.id);
  const vFestival = await post(`/api/admin/films/${filmId}/versions`, { label: 'festival', cut_note: '影展剪辑' }).then(j).then(r => r.id);
  const vDirector = await post(`/api/admin/films/${filmId}/versions`, { label: 'director', cut_note: '导演剪辑' }).then(j).then(r => r.id);
  const asset = (version_id, kind, file, extra = {}) =>
    post('/api/admin/assets', { film_id: filmId, version_id, kind, storage_path: path.join(tmp, 'storage', file), ...extra }).then(j).then(r => r.id);
  const fullFest = await asset(vFestival, 'full', 'full.bin');
  const fullDir = await asset(vDirector, 'full', 'full2.bin');
  await post('/api/admin/licenses', { film_id: filmId, asset_kind: 'full', territory: 'GLOBAL', media: 'web', starts_at: '2020-01-01T00:00:00.000Z', ends_at: '2030-01-01T00:00:00.000Z' });
  return { filmId, vFestival, vDirector, fullFest, fullDir };
}

// ───────────────── 验收 1：字幕修订 ─────────────────
test('字幕修订：修订号递增，公开详情反映新修订，放映记录仍绑定原版本', async () => {
  const { filmId, vFestival } = await makeFilmWithTwoCuts();
  await post(`/api/admin/versions/${vFestival}/publish`, { slot: 'festival_circuit' });
  await post('/api/admin/screenings', { version_id: vFestival, venue: '资料馆', screened_at: '2024-05-01T12:00:00.000Z' });

  const r = await post(`/api/admin/versions/${vFestival}/subtitle-revision`, { storage_path: path.join(tmp, 'storage', 'sub-v2.srt') });
  assert.equal(r.status, 200);
  const { subtitle_revision } = await r.json();
  assert.equal(subtitle_revision, 2);

  const detail = await fetch(`${base}/api/films/${filmId}`).then(j);
  const v = detail.versions.find(v => v.id === vFestival);
  assert.equal(v.subtitle_revision, 2, '公开详情应展示最新字幕修订号');
  assert.equal(v.screenings.length, 1, '字幕修订不影响该版本既有放映记录');
});

// ───────────────── 验收 2：展映记录补录，绑定版本不按片名合并 ─────────────────
test('展映记录补录：历史场次挂到实际版本，同片名不同剪辑不合并', async () => {
  const { filmId, vFestival, vDirector } = await makeFilmWithTwoCuts();
  await post(`/api/admin/versions/${vFestival}/publish`, { slot: 'festival_circuit' });
  await post(`/api/admin/versions/${vDirector}/publish`, { slot: 'web_public' });

  // 补录一年前的影展场次（影展剪辑）
  const r = await post('/api/admin/screenings', { version_id: vFestival, festival_name: '旧影展', venue: '老剧场', screened_at: '2023-03-15T12:00:00.000Z', notes: '补录' });
  assert.equal(r.status, 201);

  const detail = await fetch(`${base}/api/films/${filmId}`).then(j);
  const fest = detail.versions.find(v => v.id === vFestival);
  const dir = detail.versions.find(v => v.id === vDirector);
  assert.equal(fest.screenings.length, 1);
  assert.equal(fest.screenings[0].festival_name, '旧影展');
  assert.equal(dir.screenings.length, 0, '导演剪辑的放映记录不得与影展剪辑按片名合并');

  const list = await fetch(`${base}/api/films/${filmId}/screenings`).then(j);
  assert.equal(list.screenings[0].version_id, vFestival);
  assert.equal(list.screenings[0].version_label, 'festival');

  // 绑定不存在的版本应被拒绝
  const bad = await post('/api/admin/screenings', { version_id: 99999, venue: 'x', screened_at: '2024-01-01T00:00:00.000Z' });
  assert.equal(bad.status, 404);
});

// ───────────────── 验收 3：授权提前结束 ─────────────────
test('授权提前结束：缓存主动失效，探测接口立即 404 且只给批准文案、不泄露文件地址', async () => {
  const { filmId, vFestival, fullFest } = await makeFilmWithTwoCuts();
  await post(`/api/admin/versions/${vFestival}/publish`, { slot: 'web_public' });

  let probe = await fetch(`${base}/api/media/${fullFest}/probe`);
  assert.equal(probe.status, 200, '许可有效时可见');
  assert.ok(vis._size() > 0, '可见性已进缓存');

  const lic = db.get('SELECT id FROM licenses WHERE film_id=? AND asset_kind=?', [filmId, 'full']);
  const t = await post(`/api/admin/licenses/${lic.id}/terminate`, {});
  assert.equal(t.status, 200);

  // 不等待 TTL，立即不可见（主动失效）
  probe = await fetch(`${base}/api/media/${fullFest}/probe`);
  assert.equal(probe.status, 404);
  const body = await probe.json();
  assert.equal(body.available, false);
  assert.equal(body.notice, '本片暂不可公开。', '应返回经批准的文字说明');
  const raw = JSON.stringify(body);
  assert.ok(!raw.includes('storage') && !raw.includes(tmp) && !raw.includes('.bin'), '探测接口绝不泄露存储路径/文件地址');

  const file = await fetch(`${base}/api/media/${fullFest}/file`);
  assert.equal(file.status, 404, '文件流同样被拒绝');
});

// ───────────────── 验收 4：两个管理员发布不同剪辑 ─────────────────
test('两个管理员发布不同剪辑：同槽位冲突 409，force 显式替换并归档旧版，全程有审计', async () => {
  const { filmId, vFestival, vDirector } = await makeFilmWithTwoCuts();

  const r1 = await post(`/api/admin/versions/${vFestival}/publish`, { slot: 'web_public' }, ADMIN_A);
  assert.equal(r1.status, 200, 'admin-a 发布影展剪辑成功');

  const r2 = await post(`/api/admin/versions/${vDirector}/publish`, { slot: 'web_public' }, ADMIN_B);
  assert.equal(r2.status, 409, 'admin-b 发布不同剪辑到同一槽位应冲突');
  const conflict = await r2.json();
  assert.equal(conflict.error, 'publish_conflict');
  assert.equal(conflict.details.conflict_with, vFestival);

  // 强制替换：旧版归档，线上只剩一个已发布版本
  const r3 = await post(`/api/admin/versions/${vDirector}/publish`, { slot: 'web_public', force: true }, ADMIN_B);
  assert.equal(r3.status, 200);
  assert.equal((await r3.json()).replaced, vFestival);

  const versions = db.all('SELECT * FROM versions WHERE film_id=? AND slot=? AND status=?', [filmId, 'web_public', 'published']);
  assert.equal(versions.length, 1);
  assert.equal(versions[0].id, vDirector);
  assert.equal(db.get('SELECT status FROM versions WHERE id=?', [vFestival]).status, 'archived');

  const events = db.all(`SELECT * FROM publish_events WHERE version_id IN (?,?) ORDER BY id`, [vFestival, vDirector]);
  assert.ok(events.some(e => e.action === 'conflict_rejected'), '冲突拒绝有审计');
  assert.ok(events.some(e => e.action === 'unpublish'), '强制替换导致的归档有审计');
});

// ───────────────── 验收 5：请求下载时权限变更 ─────────────────
test('请求下载时权限变更：令牌签发后许可被终止，下载被拒绝', async () => {
  const { filmId, vFestival, fullFest } = await makeFilmWithTwoCuts();
  await post(`/api/admin/versions/${vFestival}/publish`, { slot: 'web_public' });

  const tokRes = await post(`/api/media/${fullFest}/download-token?region=GLOBAL`, {});
  assert.equal(tokRes.status, 200);
  const { token } = await tokRes.json();

  // 签发后、下载前：授权提前结束
  const lic = db.get('SELECT id FROM licenses WHERE film_id=? AND asset_kind=?', [filmId, 'full']);
  await post(`/api/admin/licenses/${lic.id}/terminate`, {});

  const dl = await fetch(`${base}/api/download/${token}`);
  assert.equal(dl.status, 403, '权限变更后令牌必须失效');
  assert.equal((await dl.json()).error, 'permission_revoked');

  // 伪造令牌同样被拒绝
  const fake = await fetch(`${base}/api/download/AAAA.BBBB`);
  assert.equal(fake.status, 403);
});

// ───────────────── 定时上线冲突 ─────────────────
test('定时上线：排期冲突预检 409；执行期槽位被抢占则 schedule_failed 而不覆盖', async () => {
  const { filmId, vFestival, vDirector } = await makeFilmWithTwoCuts();

  // 排期 vFestival 未来上线
  const s1 = await post(`/api/admin/versions/${vFestival}/publish`, { slot: 'web_public', scheduled_at: '2099-01-01T00:00:00.000Z' });
  assert.equal(s1.status, 200);
  // 同时给 vDirector 排期 → 预检冲突
  const s2 = await post(`/api/admin/versions/${vDirector}/publish`, { slot: 'web_public', scheduled_at: '2099-02-01T00:00:00.000Z' });
  assert.equal(s2.status, 409);

  // 执行期冲突：把 vFestival 的排期改到"已到点"，但先让 admin-b 即时发布 vDirector 抢占槽位
  db.run(`UPDATE versions SET scheduled_publish_at='2020-01-01T00:00:00.000Z' WHERE id=?`, [vFestival]);
  const now = await post(`/api/admin/versions/${vDirector}/publish`, { slot: 'web_public' }, ADMIN_B);
  assert.equal(now.status, 200);
  const run = await post('/api/admin/scheduler/run', {});
  const results = (await run.json()).results;
  assert.ok(results.some(r => r.version === vFestival && r.state === 'schedule_failed'), '到点执行遇冲突应标记失败');
  assert.equal(db.get('SELECT status FROM versions WHERE id=?', [vDirector]).status, 'published', '已发布版本不被定时任务覆盖');
});

// ───────────────── 缓存到期不超过许可结束时间 ─────────────────
test('到期缓存：缓存条目过期时间不超过许可 ends_at', async () => {
  const { filmId } = await makeFilmWithTwoCuts();
  db.run(`UPDATE licenses SET ends_at=? WHERE film_id=? AND asset_kind='full'`,
    [new Date(Date.now() + 3000).toISOString(), filmId]);
  vis.invalidate(filmId);
  assert.equal(vis.isLicensed(filmId, 'full', 'GLOBAL'), true);
  const entry = vis._entry(filmId, 'full', 'GLOBAL');
  assert.ok(entry.expires <= Date.now() + 3000, '缓存在许可结束时必然过期，不会越权续命');
});

// ───────────────── 公开搜索与详情一致 ─────────────────
test('公开搜索与详情一致：列表字段与详情同名字段完全相同', async () => {
  const { filmId, vFestival } = await makeFilmWithTwoCuts();
  await post(`/api/admin/versions/${vFestival}/publish`, { slot: 'web_public' });
  await post('/api/admin/assets', { film_id: filmId, kind: 'poster', storage_path: path.join(tmp, 'storage', 'poster.svg') });
  await post('/api/admin/licenses', { film_id: filmId, asset_kind: 'poster', territory: 'GLOBAL', media: 'web', starts_at: '2020-01-01T00:00:00.000Z', ends_at: '2030-01-01T00:00:00.000Z' });

  const search = await fetch(`${base}/api/films?query=测试片&region=CN`).then(j);
  const item = search.films.find(f => f.id === filmId);
  assert.ok(item, '搜索应能找到影片');
  const detail = await fetch(`${base}/api/films/${filmId}?region=CN`).then(j);
  for (const k of ['id', 'title', 'original_title', 'year', 'director_name', 'synopsis', 'availability', 'poster_media_id', 'notice']) {
    assert.deepEqual(detail[k], item[k], `字段 ${k} 在搜索与详情中必须一致`);
  }
});

// ───────────────── 联系表单分流与私密材料隔离 ─────────────────
test('联系表单：按合作/放映/采访分流，私密材料隔离且公开不可达', async () => {
  const cases = { collaboration: 'producer-desk', screening: 'programming-desk', interview: 'press-desk' };
  for (const [cat, queue] of Object.entries(cases)) {
    const r = await post('/api/contact', { category: cat, name: '路人', email: 'a@b.c', message: '你好' }, { 'Content-Type': 'application/json' });
    assert.equal(r.status, 201);
    assert.equal((await r.json()).routed_to, queue);
  }
  // 带私密材料的合作申请
  const secret = Buffer.from('未公开剧本内容').toString('base64');
  const r = await post('/api/contact', { category: 'collaboration', name: '编剧', email: 'w@x.y', message: '附剧本', private_material: { filename: 'script.pdf', content_base64: secret } }, { 'Content-Type': 'application/json' });
  const { id } = await r.json();

  // 公开/未认证访问一律拒绝
  for (const url of ['/api/admin/contacts', `/api/admin/contacts/${id}/material`]) {
    const res = await fetch(base + url);
    assert.equal(res.status, 401, `${url} 未认证必须 401`);
  }
  // 管理员列表不含材料路径
  const list = await fetch(`${base}/api/admin/contacts?category=collaboration`, { headers: ADMIN_A }).then(j);
  const item = list.contacts.find(c => c.id === id);
  assert.equal(item.has_private_material, 1);
  assert.ok(!('private_material_path' in item), '列表绝不返回私密材料路径');
  assert.ok(!JSON.stringify(list).includes(tmp), '响应不含服务器路径');
  // 管理员经认证接口可取回材料
  const mat = await fetch(`${base}/api/admin/contacts/${id}/material`, { headers: ADMIN_A });
  assert.equal(mat.status, 200);
  assert.equal(await mat.text(), '未公开剧本内容');
  // 非法类别被拒
  const bad = await post('/api/contact', { category: 'other', name: 'x', email: 'x', message: 'x' }, { 'Content-Type': 'application/json' });
  assert.equal(bad.status, 400);
});

// ───────────────── 署名：原文保留、不自动夸大 ─────────────────
test('署名：按来源原文展示并带核实标记，不做自动升格或合并', async () => {
  const { filmId } = await makeFilmWithTwoCuts();
  await post('/api/admin/credits', { film_id: filmId, person_name: '张三', role: '实习场记', verified: false, source: '剧组口述' });
  await post('/api/admin/credits', { film_id: filmId, person_name: '张三', role: '花絮摄影', verified: true, source: '片尾字幕截图' });

  const detail = await fetch(`${base}/api/films/${filmId}`).then(j);
  const mine = detail.credits.filter(c => c.person_name === '张三');
  assert.equal(mine.length, 2, '同一人的不同职责保留为独立记录，不合并');
  assert.ok(mine.some(c => c.role === '实习场记' && c.verified === false));
  assert.ok(mine.some(c => c.role === '花絮摄影' && c.verified === true));
  assert.ok(!mine.some(c => /总|总监|指导/.test(c.role)), '不得自动升格署名');
});

// ───────────────── 地域与媒介范围分别检查 ─────────────────
test('许可按地域/媒介/素材类型分别检查：预告、剧照、完整影片互不影响', async () => {
  const { filmId, vFestival, fullFest } = await makeFilmWithTwoCuts();
  await post(`/api/admin/versions/${vFestival}/publish`, { slot: 'web_public' });
  const trailerId = await post('/api/admin/assets', { film_id: filmId, version_id: vFestival, kind: 'trailer', storage_path: path.join(tmp, 'storage', 'trailer.bin') }).then(j).then(r => r.id);
  // full 仅 GLOBAL（继承自建片），trailer 仅 CN
  await post('/api/admin/licenses', { film_id: filmId, asset_kind: 'trailer', territory: 'CN', media: 'web', starts_at: '2020-01-01T00:00:00.000Z', ends_at: '2030-01-01T00:00:00.000Z' });

  const g = await fetch(`${base}/api/films/${filmId}?region=US`).then(j);
  assert.equal(g.availability.full, true, 'US：完整影片有 GLOBAL 许可');
  assert.equal(g.availability.trailer, false, 'US：预告仅授权 CN');
  const cn = await fetch(`${base}/api/films/${filmId}?region=CN`).then(j);
  assert.equal(cn.availability.trailer, true, 'CN：预告可见');
  const probe = await fetch(`${base}/api/media/${trailerId}/probe?region=US`);
  assert.equal(probe.status, 404, '素材级探测同样遵守地域限制');
});
