'use strict';
/**
 * 验收测试：
 *  1. 字幕修订            5. 请求下载时权限变更
 *  2. 展映记录补录         6. 媒体探测不泄漏文件地址
 *  3. 授权提前结束         7. 联系表单分流与私密材料隔离
 *  4. 双管理员发布不同剪辑  8. 搜索与详情一致 / 定时上线 / 署名不夸大
 */
const { initDb } = require('../src/db');
const { createApp } = require('../src/server');

const A = { 'Content-Type': 'application/json', 'x-admin-token': 'token-admin-a' };
const B = { 'Content-Type': 'application/json', 'x-admin-token': 'token-admin-b' };
const J = { 'Content-Type': 'application/json' };

let base, passed = 0, failed = 0;
function ok(cond, name, extra = '') {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.log(`  ✗ ${name} ${extra}`); }
}
const get = async (p, h) => (await fetch(base + p, { headers: h }));
const post = async (p, body, h) => (await fetch(base + p, { method: 'POST', headers: h || J, body: JSON.stringify(body || {}) }));

async function makePublishedFilm(admin, { fullFilmTerritories = ['WORLD'], fullFilmEnd = null } = {}) {
  const past = new Date(Date.now() - 864e5).toISOString();
  const film = (await (await post('/api/admin/films', { title: '验收片' + Math.random(), fallback_text: '经批准：本片暂不可公开。', fallback_approved: true }, admin)).json());
  const v1 = (await (await post('/api/admin/versions', { film_id: film.id, label: 'festival', runtime_sec: 600 }, admin)).json());
  const v2 = (await (await post('/api/admin/versions', { film_id: film.id, label: 'public', runtime_sec: 590 }, admin)).json());
  await post('/api/admin/release-list', { version_id: v2.id, approved: true }, admin);
  await post(`/api/admin/versions/${v2.id}/publish`, {}, admin);
  const licFull = (await (await post('/api/admin/licenses',
    { film_id: film.id, version_id: v2.id, media_kind: 'full_film', territories: fullFilmTerritories, start_at: past, end_at: fullFilmEnd }, admin)).json());
  await post('/api/admin/licenses', { film_id: film.id, media_kind: 'poster', territories: ['WORLD'], start_at: past }, admin);
  const asset = (await (await post('/api/admin/assets',
    { film_id: film.id, version_id: v2.id, kind: 'full_film', storage_path: 'data/media/f1-full.mp4' }, admin)).json());
  return { film, v1, v2, licFull, asset };
}

async function main() {
  const db = await initDb({ inMemory: true });
  const app = createApp(db);
  const server = await new Promise((r) => { const s = app.listen(0, () => r(s)); });
  base = `http://127.0.0.1:${server.address().port}`;
  console.log('验收测试开始 →', base, '\n');

  // ============ 场景 1：字幕修订 ============
  console.log('【场景1】字幕修订');
  {
    const { film, v2 } = await makePublishedFilm(A);
    const past = new Date(Date.now() - 864e5).toISOString();
    await post('/api/admin/licenses', { film_id: film.id, version_id: v2.id, media_kind: 'subtitle', territories: ['WORLD'], start_at: past }, A);
    const sub1 = (await (await post('/api/admin/assets', { film_id: film.id, version_id: v2.id, kind: 'subtitle', storage_path: 'data/media/f1-sub-v1.srt' }, A)).json());
    let detail = await (await get(`/api/films/${film.id}`)).json();
    ok(detail.subtitles[0].revision === 1, '初始字幕为修订 v1');

    const rev = (await (await post(`/api/admin/assets/${sub1.id}/revise`, { storage_path: 'data/media/f1-sub-v1.srt' }, B)).json());
    ok(rev.revision === 2, '管理员B提交修订 v2');
    detail = await (await get(`/api/films/${film.id}`)).json();
    ok(detail.subtitles[0].revision === 2, '公开端立即提供最新修订 v2');
    const history = db.all('SELECT * FROM assets WHERE kind = ? ORDER BY revision', ['subtitle']);
    ok(history.length === 2 && history[0].revision === 1, '旧修订 v1 保留可回溯');
  }

  // ============ 场景 2：展映记录补录（绑定实际版本） ============
  console.log('【场景2】展映记录补录');
  {
    const { film, v1, v2 } = await makePublishedFilm(A);
    const d1 = new Date(Date.now() - 200 * 864e5).toISOString(), d2 = new Date(Date.now() - 5 * 864e5).toISOString();
    await post('/api/admin/screenings', { film_id: film.id, version_id: v1.id, event_name: '某影展', screened_at: d1, source: '补录' }, A);
    await post('/api/admin/screenings', { film_id: film.id, version_id: v2.id, event_name: '线上放映', screened_at: d2 }, A);
    const detail = await (await get(`/api/films/${film.id}`)).json();
    const labels = detail.screenings.map((s) => s.version_label).sort();
    ok(detail.screenings.length === 2 && labels.join() === 'festival,public', '同一片名两条放映分别绑定影展版/公开版，未合并');
    // 版本不属于该影片时必须拒绝
    const other = await makePublishedFilm(A);
    const bad = await post('/api/admin/screenings', { film_id: film.id, version_id: other.v2.id, screened_at: d2 }, A);
    ok(bad.status === 422, '跨影片绑定版本被拒绝(422)');
  }

  // ============ 场景 3：授权提前结束 ============
  console.log('【场景3】授权提前结束');
  {
    const future = new Date(Date.now() + 30 * 864e5).toISOString();
    const { film, asset, licFull } = await makePublishedFilm(A, { fullFilmEnd: future });
    let probe = await (await get(`/api/media/probe?asset_id=${asset.id}`)).json();
    ok(probe.available === true, '终止前完整片可看');
    // 先填满缓存，再终止 —— 验证缓存即时失效
    await get(`/api/films/${film.id}`);
    await post(`/api/admin/licenses/${licFull.id}/terminate`, { reason: '版权方要求提前下架' }, B);
    probe = await (await get(`/api/media/probe?asset_id=${asset.id}`)).json();
    ok(probe.available === false && probe.reason === 'license_terminated', '终止后探测立即不可用(缓存已失效)');
    ok(probe.fallback_text && probe.fallback_text.includes('经批准'), '不可公开时返回经批准的文字说明');
    const detail = await (await get(`/api/films/${film.id}`)).json();
    ok(detail.has_full_film === false && detail.fallback_text, '详情页同步降级为文字说明');
  }

  // ============ 场景 4：两个管理员发布不同剪辑 ============
  console.log('【场景4】双管理员发布不同剪辑');
  {
    const film = (await (await post('/api/admin/films', { title: '双剪辑冲突片' }, A)).json());
    const cutA = (await (await post('/api/admin/versions', { film_id: film.id, label: 'public' }, A)).json());
    const cutB = (await (await post('/api/admin/versions', { film_id: film.id, label: 'director' }, B)).json());
    const r1 = await post(`/api/admin/versions/${cutA.id}/publish`, {}, A);
    ok(r1.status === 200, '管理员A发布公开版成功');
    const r2 = await post(`/api/admin/versions/${cutB.id}/publish`, {}, B);
    ok(r2.status === 409, '管理员B发布导演版被拒(409)，不覆盖他人发布');
    const r2b = await post(`/api/admin/versions/${cutB.id}/publish`, { supersede: true }, B);
    ok(r2b.status === 200, 'B 显式 supersede 后发布成功');
    const ov = await (await get('/api/admin/overview', A)).json();
    const vs = ov.versions.filter((v) => v.film_id === film.id);
    ok(vs.find((v) => v.id === cutA.id).status === 'archived' && vs.find((v) => v.id === cutB.id).status === 'published',
      '原子替换：旧版归档、新版发布，绝无两个已发布版本');
    const audit = await (await get('/api/admin/audit', A)).json();
    ok(audit.audit.some((a) => a.actor === 'admin-a' && a.action === 'publish') && audit.audit.some((a) => a.actor === 'admin-b' && a.action === 'publish'),
      '两名管理员操作均留审计');
  }

  // ============ 场景 5：请求下载时权限变更 ============
  console.log('【场景5】请求下载时权限变更');
  {
    const future = new Date(Date.now() + 30 * 864e5).toISOString();
    const { asset, licFull } = await makePublishedFilm(A, { fullFilmEnd: future });
    const tok = (await (await post(`/api/media/${asset.id}/request-download`, { territory: 'WORLD' })).json());
    ok(!!tok.stream_url, '许可有效时签发下载令牌');
    const dlOk = await get(tok.stream_url.replace(base, ''));
    ok(dlOk.status === 200, '令牌可正常下载');
    // 令牌签发后、下载前权限被终止
    const tok2 = (await (await post(`/api/media/${asset.id}/request-download`, {})).json());
    await post(`/api/admin/licenses/${licFull.id}/terminate`, { reason: '紧急下架' }, A);
    const dlDenied = await get(tok2.stream_url.replace(base, ''));
    ok(dlDenied.status === 403, '下载开始时复核许可：已终止 → 403');
    const body = await dlDenied.json();
    ok(body.reason === 'license_terminated', '拒绝原因明确');
  }

  // ============ 场景 6：媒体探测不泄漏文件地址 ============
  console.log('【场景6】媒体探测接口安全');
  {
    const { asset } = await makePublishedFilm(A);
    for (const path of [`/api/media/probe?asset_id=${asset.id}`, `/api/media/probe?asset_id=9999`]) {
      const raw = await (await get(path)).text();
      ok(!raw.includes('data/media') && !raw.includes('storage_path'), `探测响应不含存储路径 (${path})`);
    }
    const list = await (await get('/api/films')).text();
    ok(!list.includes('data/media'), '公开列表不含存储路径');
  }

  // ============ 场景 7：联系表单分流与私密材料隔离 ============
  console.log('【场景7】联系表单分流与私密隔离');
  {
    const r = await post('/api/contact', { category: 'interview', name: '记者甲', email: 'press@example.com', message: '希望采访导演', private_material: '未公开片段链接XYZ' });
    ok(r.status === 201, '采访类表单提交成功');
    const echo = await r.json();
    ok(!('private_material' in echo), '提交回执不回显私密材料');
    const bad = await post('/api/contact', { category: 'gossip', name: 'x', email: 'x@x.com', message: 'x' });
    ok(bad.status === 400, '非法类别被拒绝');
    const coop = await (await get('/api/admin/contacts?category=cooperation', A)).json();
    const itv = await (await get('/api/admin/contacts?category=interview', A)).json();
    ok(coop.contacts.length === 0 && itv.contacts.length === 1, '队列按类别分流隔离');
    ok(itv.contacts[0].private_material.includes('XYZ'), '私密材料仅管理员队列可见');
    const pub = await get('/api/contacts');
    ok(pub.status === 404, '公开侧无联系表单读取接口');
    const noAuth = await get('/api/admin/contacts');
    ok(noAuth.status === 401, '无令牌访问队列被拒');
  }

  // ============ 场景 8：搜索与详情一致 / 定时上线 / 署名不夸大 ============
  console.log('【场景8】一致性 · 定时上线 · 署名');
  {
    const future = new Date(Date.now() + 30 * 864e5).toISOString();
    const { film } = await makePublishedFilm(A, { fullFilmTerritories: ['CN'], fullFilmEnd: future });
    // 地域差异：CN 可看，US 不可看 —— 搜索与详情必须一致
    const listCN = (await (await get('/api/films?territory=CN')).json()).films.find((f) => f.id === film.id);
    const detailCN = await (await get(`/api/films/${film.id}?territory=CN`)).json();
    const listUS = (await (await get('/api/films?territory=US')).json()).films.find((f) => f.id === film.id);
    const detailUS = await (await get(`/api/films/${film.id}?territory=US`)).json();
    ok(listCN.has_full_film === detailCN.has_full_film && listUS.has_full_film === detailUS.has_full_film,
      '搜索与详情可见性一致（CN/US 两地）');
    ok(listCN.has_full_film === true && listUS.has_full_film === false, '地域许可生效：CN 可看 / US 不可看');

    // 定时上线：not_before 在未来 → 不可见
    const film2 = (await (await post('/api/admin/films', { title: '定时上线片' }, A)).json());
    const v = (await (await post('/api/admin/versions', { film_id: film2.id, label: 'public' }, A)).json());
    await post(`/api/admin/versions/${v.id}/publish`, {}, A);
    const nb = new Date(Date.now() + 3600e3).toISOString();
    await post('/api/admin/release-list', { version_id: v.id, approved: true, not_before: nb }, A);
    const past = new Date(Date.now() - 864e5).toISOString();
    await post('/api/admin/licenses', { film_id: film2.id, version_id: v.id, media_kind: 'full_film', territories: ['WORLD'], start_at: past, end_at: future }, A);
    const a2 = (await (await post('/api/admin/assets', { film_id: film2.id, version_id: v.id, kind: 'full_film', storage_path: 'data/media/f1-full.mp4' }, A)).json());
    const probe = await (await get(`/api/media/probe?asset_id=${a2.id}`)).json();
    ok(probe.available === false && probe.reason === 'scheduled_future', '定时上线未到：许可有效也不可见');

    // 署名不夸大：原样返回
    await post(`/api/admin/films/${film.id}/credits`, { person_name: '张三', role: '摄影助理', verified: true, source: '片尾字幕' }, A);
    const d = await (await get(`/api/films/${film.id}`)).json();
    const c = d.credits.find((x) => x.person_name === '张三');
    ok(c && c.role === '摄影助理' && c.verified === 1, '署名按可核实职责原样展示，不自动升格');
    const noSrc = await post(`/api/admin/films/${film.id}/credits`, { person_name: '李四', role: '导演', verified: true }, A);
    ok(noSrc.status === 400, '声称已核实但无来源 → 拒绝');
  }

  console.log(`\n结果：${passed} 通过 / ${failed} 失败`);
  server.close();
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error('测试运行异常:', e); process.exit(1); });
