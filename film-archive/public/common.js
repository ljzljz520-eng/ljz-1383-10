const REGIONS = { GLOBAL: '全球', CN: '中国大陆', US: '美国', EU: '欧洲' };
const VERSION_LABELS = { festival: '影展版', public: '公开版', director: '导演版' };
const KIND_LABELS = { poster: '海报', still: '剧照', trailer: '预告', clip: '公开片段', full: '完整影片' };

function getRegion() { return localStorage.getItem('region') || 'GLOBAL'; }
function setRegion(r) { localStorage.setItem('region', r); }

function regionSelector(el) {
  el.innerHTML = '';
  const sel = document.createElement('select');
  for (const [v, t] of Object.entries(REGIONS)) {
    const o = document.createElement('option'); o.value = v; o.textContent = `地区：${t}`;
    if (v === getRegion()) o.selected = true;
    sel.appendChild(o);
  }
  sel.onchange = () => { setRegion(sel.value); location.reload(); };
  el.appendChild(sel);
}

async function api(path, opts = {}) {
  const res = await fetch(path, opts);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) { const e = new Error(data.message || data.error || res.status); e.status = res.status; e.data = data; throw e; }
  return data;
}

function availabilityBadges(av) {
  return Object.entries(KIND_LABELS).map(([k, label]) =>
    `<span class="badge ${av && av[k] ? 'on' : 'off'}">${label}${av && av[k] ? '' : ' · 不可见'}</span>`).join('');
}
