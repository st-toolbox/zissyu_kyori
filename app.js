'use strict';
// 実習配置アプリ（2026-10-21 作り直し）
// 片道 = ①学生の駅まで（申告） + ②駅→駅（Maps） + ③施設の駅から（施設ごとに先生が決める）。住所は持たない。

firebase.initializeApp({
  apiKey: 'AIzaSyDcpjRgLTUTHeMIsXznh9P1em87YXC0Kwc',
  authDomain: 'zissyu-kyori.firebaseapp.com',
  databaseURL: 'https://zissyu-kyori-default-rtdb.asia-southeast1.firebasedatabase.app',
  projectId: 'zissyu-kyori',
});
const auth = firebase.auth();
const db = firebase.database();

const TYPES = ['評価', '総合', '見学'];
const MODES = ['徒歩', '自転車', '車', '送迎', 'バス'];
const DEF_SET = { good: 60, ok: 80, warn: 90, rule: 105, yutori: 5, gasUrl: '' };

const S = {
  user: null, settings: { ...DEF_SET }, facilities: {}, routes: {}, years: {}, teachers: {}, invites: {},
  year: null, view: 'fac', type: '評価', sel: null, sort: 'todo', calcStop: false, calcing: false,
};

// ===== 小道具 =====
const $ = id => document.getElementById(id);
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const num = v => (v === '' || v == null || isNaN(+v)) ? null : +v;
const now = () => new Date().toISOString();
const me = () => (S.user && S.user.email) || '';
const fmtMin = m => m == null ? '—' : (m < 60 ? m + '分' : Math.floor(m / 60) + '時間' + (m % 60 ? m % 60 + '分' : ''));
const fmtAt = iso => iso ? iso.slice(0, 16).replace('T', ' ') : '';
function toast(msg) { const t = $('toast'); t.textContent = msg; t.style.display = 'block'; clearTimeout(toast.t); toast.t = setTimeout(() => t.style.display = 'none', 2600); }
function busy(on, msg) { $('busy').textContent = msg || '読み込み中…'; $('busy').style.display = on ? 'flex' : 'none'; }
function fail(e) { console.error(e); alert('うまくいかなかった：' + (e && e.message || e)); }
// Firebase のキーに使えない文字を置き換える
const fk = s => String(s || '').trim().replace(/駅$/, '').replace(/[.#$/\[\]]/g, '_');
const mailKey = m => String(m || '').trim().toLowerCase().replace(/\./g, ',');
const stName = s => String(s || '').trim().replace(/駅$/, '');
function schoolYear() { const d = new Date(); return String(d.getMonth() >= 3 ? d.getFullYear() : d.getFullYear() - 1); }
function newId() { return 'f' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5); }

// ===== ログイン =====
$('btn-login').onclick = () => {
  $('login-err').textContent = '';
  auth.signInWithPopup(new firebase.auth.GoogleAuthProvider()).catch(e => $('login-err').textContent = 'ログインできなかった：' + e.message);
};
$('btn-logout').onclick = () => { if (confirm('ログアウトする？')) auth.signOut(); };

auth.onAuthStateChanged(async user => {
  S.user = user;
  if (!user) { $('login').style.display = 'flex'; $('app').classList.remove('on'); return; }
  busy(true);
  try {
    const ok = await ensureTeacher(user);
    if (!ok) { busy(false); return; }
    $('login').style.display = 'none';
    $('app').classList.add('on');
    $('who').textContent = user.email;
    listen();
  } catch (e) { busy(false); fail(e); }
});

// 先生か確かめる。招待されていれば、ここで自分を先生に足す
async function ensureTeacher(user) {
  const tSnap = await db.ref('teachers/' + user.uid).once('value').catch(() => null);
  if (tSnap && tSnap.exists()) return true;
  const inv = await db.ref('invites/' + mailKey(user.email)).once('value').catch(() => null);
  if (inv && inv.exists()) {
    await db.ref('teachers/' + user.uid).set({ email: user.email, name: user.displayName || '', at: now(), invitedBy: inv.val().by || '' });
    await db.ref('invites/' + mailKey(user.email)).remove();
    return true;
  }
  $('login').style.display = 'flex';
  $('login-err').textContent = 'まだ先生として招待されていない（' + user.email + '）。\n招待済みの先生に「先生」の画面から招待してもらう。\n\n最初の1人だけは、Firebase のコンソールで Realtime Database の teachers の下に次の名前で1件足す：\n' + user.uid + '\n（中身は email: ' + user.email + '）';
  return false;
}

// ===== 読み込み（先生が複数いるので、変わったらすぐ反映） =====
function listen() {
  let first = 5;
  const done = () => { if (--first === 0) { busy(false); initYear(); render(); } else if (first < 0) render(); };
  db.ref('settings').on('value', s => { S.settings = { ...DEF_SET, ...(s.val() || {}) }; done(); }, fail);
  db.ref('facilities').on('value', s => { S.facilities = s.val() || {}; done(); }, fail);
  db.ref('routes').on('value', s => { S.routes = s.val() || {}; done(); }, fail);
  db.ref('years').on('value', s => { S.years = s.val() || {}; done(); }, fail);
  db.ref('teachers').on('value', s => { S.teachers = s.val() || {}; done(); }, fail);
  db.ref('invites').on('value', s => { S.invites = s.val() || {}; render(); }, () => {});
}

function initYear() {
  const cur = schoolYear();
  const ys = new Set(Object.keys(S.years)); ys.add(cur); ys.add(String(+cur + 1));
  S.year = S.year || cur;
  $('year-sel').innerHTML = [...ys].sort().reverse().map(y => `<option value="${y}">${y}年度</option>`).join('');
  $('year-sel').value = S.year;
}
$('year-sel').onchange = async e => {
  const y = e.target.value;
  if (!S.years[y] || !S.years[y].facilities) {
    const prev = Object.keys(S.years).filter(k => k < y && S.years[k].facilities).sort().pop();
    if (prev && confirm(`${y}年度は空。${prev}年度の受入人数・始業時刻を写して始める？（学生は写さない）`)) {
      await db.ref(`years/${y}/facilities`).set(S.years[prev].facilities).catch(fail);
    }
  }
  S.year = y; S.sel = null; render();
};

const Y = () => S.years[S.year] || {};
const yFac = fid => (Y().facilities || {})[fid] || {};
const students = () => Y().students || {};
const asg = t => ((Y().assignments || {})[t]) || {};
const ypath = p => `years/${S.year}/${p}`;

// ===== 画面の切り替え =====
$('nav').onclick = e => { const b = e.target.closest('button[data-v]'); if (b) { S.view = b.dataset.v; render(); } };
function render() {
  if (!S.year) return;
  document.querySelectorAll('#nav button').forEach(b => b.classList.toggle('on', b.dataset.v === S.view));
  document.querySelectorAll('main > section').forEach(s => s.classList.toggle('on', s.id === 'v-' + S.view));
  ({ fac: renderFac, stu: renderStu, calc: renderCalc, asg: renderAsg, prt: () => {}, tch: renderTch, set: renderSet })[S.view]();
}

// ===== 計算のもと =====
// 施設の駅から先（③）の分数
function leg3(f) { return (f.access && f.access !== '徒歩') ? num(f.accessMin) : num(f.walk); }
function startOf(fid) { return yFac(fid).start || '08:30'; }
// 駅に着きたい時刻＝始業−③−ゆとり（5分きざみに切り下げ）
function arriveBy(fid) {
  const f = S.facilities[fid]; const l3 = leg3(f);
  if (l3 == null) return null;
  const [h, m] = startOf(fid).split(':').map(Number);
  let t = h * 60 + m - l3 - (num(S.settings.yutori) || 0);
  t = Math.floor(t / 5) * 5;
  return String(Math.floor(t / 60)).padStart(2, '0') + ':' + String(t % 60).padStart(2, '0');
}
const rKey = (a, b, arr) => fk(a) + '__' + fk(b) + '__' + arr.replace(':', '');

function bases(s) {
  const out = [];
  if (s.st && num(s.min) != null) out.push({ k: 'ふだん', st: s.st, mode: s.mode || '徒歩', min: num(s.min) });
  if (s.jk && s.jk.ok && s.jk.st) out.push({ k: '実家', st: s.jk.st, mode: s.jk.mode || '徒歩', min: num(s.jk.min) || 0 });
  return out;
}

// 学生×施設の片道。いちばん短い通い方を返す
function evalPair(sid, fid) {
  const s = students()[sid] || {}, f = S.facilities[fid] || {};
  const opts = []; let pending = false, errs = [];
  const l3 = leg3(f), arr = arriveBy(fid);
  for (const b of bases(s)) {
    if (!f.station || l3 == null || !arr) { pending = true; continue; }
    const r = S.routes[rKey(b.st, f.station, arr)];
    if (!r) { pending = true; continue; }
    if (r.err) { errs.push(b.k + '：' + r.err); continue; }
    opts.push({ k: b.k, total: b.min + r.ride + l3, b, r, l3 });
  }
  const car = (((Y().car || {})[sid]) || {})[fid];
  if (s.carDirect && f.carOk && car != null) opts.push({ k: '車', total: +car });
  opts.sort((a, b) => a.total - b.total);
  const best = opts[0] || null;
  let prop = null;   // 駅に自転車を置けば
  if (best && best.k !== '車' && (f.access || '徒歩') === '徒歩' && num(f.bike) != null && num(f.bike) < num(f.walk) && best.total > num(S.settings.ok)) {
    prop = best.total - num(f.walk) + num(f.bike);
    if (prop > num(S.settings.warn)) prop = null;  // 自転車にしても△に収まらないなら出さない
  }
  return { best, opts, pending: !best && pending, errs, prop };
}
function mark(total) {
  const st = S.settings;
  if (total == null) return { m: '？', c: 'mk-none', stay: false };
  if (total <= st.good) return { m: '◎', c: 'mk-good', stay: false };
  if (total <= st.ok) return { m: '○', c: 'mk-ok', stay: false };
  if (total <= st.warn) return { m: '△', c: 'mk-warn', stay: false };
  return { m: total <= st.rule ? '×' : '宿', c: 'mk-bad', stay: true };
}
const isStay = ev => !ev.best || ev.best.total > S.settings.warn;

// その種別で動いている施設（受入人数が1以上）
const facsOf = t => Object.keys(S.facilities).filter(fid => num(((yFac(fid).cap) || {})[t]) > 0)
  .sort((a, b) => (S.facilities[a].name || '').localeCompare(S.facilities[b].name || '', 'ja'));
const studsOf = t => Object.keys(students()).filter(sid => (students()[sid].t || {})[t]);

// 過去の実習先（ほかの年度の配置＋手で足した名前）
function pastOf(sid) {
  const set = new Set();
  for (const [y, yd] of Object.entries(S.years)) {
    if (y === S.year) continue;
    for (const t of TYPES) { const a = ((yd.assignments || {})[t] || {})[sid]; if (a && a.fid) set.add(a.fid); }
  }
  const s = students()[sid] || {};
  for (const t of TYPES) { if (t === S.type) continue; const a = asg(t)[sid]; if (a && a.fid) set.add(a.fid); }
  String(s.past || '').split(/[、,，\s]+/).filter(Boolean).forEach(nm => {
    const fid = Object.keys(S.facilities).find(k => S.facilities[k].name === nm); if (fid) set.add(fid);
  });
  return set;
}

// ===== 1. 施設 =====
function renderFac() {
  const fids = Object.keys(S.facilities).sort((a, b) => (S.facilities[a].name || '').localeCompare(S.facilities[b].name || '', 'ja'));
  let h = `<tr><th>施設</th><th>駅</th><th class="num">駅から</th><th>小児</th><th>車通勤</th>${TYPES.map(t => `<th class="num">${t}</th>`).join('')}<th>始業</th><th>駅に着く時刻</th></tr>`;
  if (!fids.length) h += `<tr><td colspan="11" class="hint">まだ施設が無い。「施設を足す」「表から貼り付け」か「古い控えから施設を取り込む」。</td></tr>`;
  for (const fid of fids) {
    const f = S.facilities[fid], yf = yFac(fid), cap = yf.cap || {};
    const l3 = leg3(f);
    const acc = (f.access && f.access !== '徒歩') ? `${f.access}${f.accessMin != null ? f.accessMin + '分' : '?'}` : (f.walk != null ? `徒歩${f.walk}分` : '<span class="tag yel">未計算</span>');
    const bike = num(f.bike) != null && (f.access || '徒歩') === '徒歩' ? `<span class="tag">自転車${f.bike}分</span>` : '';
    h += `<tr class="clk" data-fid="${fid}"><td>${esc(f.name)}${f.draft ? ' <span class="tag yel">駅は下書き</span>' : ''}<div class="hint" style="margin:0">${esc(f.address)}</div></td>
      <td>${f.station ? esc(stName(f.station)) + (f.stopKind && f.stopKind !== '電車' ? ` <span class="tag">${esc(f.stopKind)}</span>` : '') : '<span class="tag red">駅なし</span>'}</td><td class="num">${acc}${bike}</td>
      <td>${f.pediatric ? '小児' : ''}</td><td>${f.carOk ? '可' : ''}</td>
      ${TYPES.map(t => `<td class="num">${num(cap[t]) || ''}</td>`).join('')}<td>${esc(yf.start || '')}</td><td>${l3 != null ? (arriveBy(fid) || '') : ''}</td></tr>`;
  }
  $('fac-table').innerHTML = h;
}
$('fac-table').onclick = e => { const tr = e.target.closest('tr[data-fid]'); if (tr) openFac(tr.dataset.fid); };
$('fac-add').onclick = () => openFac(null);

function openFac(fid) {
  const f = fid ? S.facilities[fid] : {}, yf = fid ? yFac(fid) : {}, cap = yf.cap || {};
  const fm = $('f-fac');
  fm.reset();
  ['name', 'address', 'station', 'walk', 'bike', 'accessMin', 'note'].forEach(k => fm[k].value = f[k] == null ? '' : f[k]);
  if (fm.station.value) fm.station.value = stName(fm.station.value);
  fm.access.value = f.access || '徒歩';
  fm.pediatric.checked = !!f.pediatric; fm.carOk.checked = !!f.carOk;
  TYPES.forEach(t => fm['cap' + t].value = cap[t] == null ? '' : cap[t]);
  fm.start.value = yf.start || '08:30';
  $('fac-del').style.display = fid ? '' : 'none';
  $('fac-del').onclick = async () => {
    if (!confirm(`「${f.name}」を消す？（どの年度の配置にも出なくなる）`)) return;
    await db.ref().update({ ['facilities/' + fid]: null, [ypath('facilities/' + fid)]: null }).catch(fail);
    $('dlg-fac').close();
  };
  $('dlg-fac').onclose = async () => {
    if ($('dlg-fac').returnValue !== 'ok') return;
    const id = fid || newId();
    const oldSt = f.station, newSt = stName(fm.station.value);
    const rec = {
      name: fm.name.value.trim(), address: fm.address.value.trim(), station: newSt,
      walk: num(fm.walk.value), bike: num(fm.bike.value), access: fm.access.value, accessMin: num(fm.accessMin.value),
      pediatric: fm.pediatric.checked, carOk: fm.carOk.checked, note: fm.note.value.trim(),
      draft: (f.draft && stName(oldSt) === newSt) ? true : null,
      stopKind: stName(oldSt) === newSt ? (f.stopKind || null) : null, stopLoc: stName(oldSt) === newSt ? (f.stopLoc || null) : null,
    };
    // 駅や住所が変わったら、徒歩の分数は計算し直す
    if (fid && (stName(oldSt) !== newSt || (f.address || '') !== rec.address) && num(fm.walk.value) === num(f.walk)) { rec.walk = null; rec.bike = null; }
    const cap2 = {}; TYPES.forEach(t => cap2[t] = num(fm['cap' + t].value) || 0);
    await db.ref().update({ ['facilities/' + id]: rec, [ypath('facilities/' + id)]: { cap: cap2, start: fm.start.value || '08:30' } }).catch(fail);
    toast('保存した');
  };
  $('dlg-fac').returnValue = '';
  $('dlg-fac').showModal();
}

// 表から貼り付け（施設）
const FAC_COLS = ['施設名', '住所', '駅', '駅から徒歩分', '駅から先の手段', 'バス送迎分', '小児', '車通勤可', '評価人数', '総合人数', '見学人数', '始業'];
// 1行目が見出しなら名前で列を拾う（旧アプリの「種別・施設名・住所・小児・時間・受入人数」の形も読む）
const FAC_ALIAS = [
  [0, /^施設名?$/], [1, /^住所$/], [2, /^(最寄り?)?駅$/], [3, /徒歩/], [4, /手段/], [5, /(バス|送迎)/], [6, /小児/], [7, /車/],
  [8, /^評価/], [9, /^総合/], [10, /^見学/], [11, /^(始業|時間|開始)/], ['type', /^種別$/], ['n', /^(受入)?人数$/],
];
function facRows(rows) {
  const head = rows[0] || [];
  if (!head.some(h => /^施設名?$/.test(String(h).trim()))) return rows;
  const pos = {};
  head.forEach((h, i) => { const a = FAC_ALIAS.find(([, re]) => re.test(String(h).trim())); if (a && !(a[0] in pos)) pos[a[0]] = i; });
  return rows.slice(1).map(r => {
    const o = new Array(12).fill('');
    Object.entries(pos).forEach(([k, i]) => { if (!isNaN(k)) o[k] = (r[i] || '').trim(); });
    const t = pos.type != null ? String(r[pos.type] || '').trim() : '';
    if (pos.n != null && TYPES.includes(t)) o[8 + TYPES.indexOf(t)] = (r[pos.n] || '').trim();
    if (o[11]) o[11] = normTime(o[11]);
    return o;
  });
}
$('fac-paste').onclick = () => openPaste('施設を表から貼り付け', '1行目に見出し（施設名・住所・小児・始業 など）があれば名前で読む。見出しが無ければ列の順：' + FAC_COLS.join('・') + '。「種別」と「受入人数」の列があれば、その種別の人数に入れる。○/1/可/TRUE を「はい」と読む。同じ施設名はその行で上書き（空の欄は今の値のまま）。', async rows => {
  rows = facRows(rows);
  const byName = {}; Object.entries(S.facilities).forEach(([k, f]) => byName[f.name] = k);
  const up = {}; let n = 0;
  for (const r of rows) {
    if (!r[0] || r[0] === '施設名') continue;
    const id = byName[r[0]] || newId(); byName[r[0]] = id;
    // 同じ施設が種別ちがいで何行あっても足し合わせる（前の行で作った分を引き継ぐ）
    const f = { ...(up['facilities/' + id] || S.facilities[id] || {}) }, yf = { ...(up[ypath('facilities/' + id)] || yFac(id)) }, cap = { ...(yf.cap || {}) };
    f.name = r[0];
    if (r[1]) f.address = r[1];
    if (r[2]) { if (stName(r[2]) !== stName(f.station)) { f.stopKind = null; f.stopLoc = null; } f.station = stName(r[2]); f.draft = null; }
    if (r[3]) f.walk = num(r[3]);
    if (r[4]) f.access = ['徒歩', 'バス', '送迎'].includes(r[4]) ? r[4] : '徒歩';
    if (r[5]) f.accessMin = num(r[5]);
    if (r[6]) f.pediatric = yes(r[6]);
    if (r[7]) f.carOk = yes(r[7]);
    TYPES.forEach((t, i) => { if (r[8 + i] !== undefined && r[8 + i] !== '') cap[t] = num(r[8 + i]) || 0; });
    yf.cap = cap; yf.start = r[11] || yf.start || '08:30';
    up['facilities/' + id] = f; up[ypath('facilities/' + id)] = yf; n++;
  }
  await db.ref().update(up); toast(n + '施設を取り込んだ');
});
const yes = v => /^(○|〇|1|可|はい|有|yes|y|true|✓)$/i.test(String(v).trim());

// 旧アプリの施設を取り込む。まずデータベースに残っている /locations（先生だけ読める）を読み、
// 読めなければ控えの JSON を選ばせる。学生・住所・計算結果は読まない
$('fac-import').onclick = async () => {
  let locs = null;
  try { locs = (await db.ref('locations').once('value')).val(); } catch (_) { }
  if (locs) return importLocs(locs);
  if (confirm('データベースに旧アプリの施設が見当たらない（または読めない）。控えの JSON から取り込む？')) $('fac-file').click();
};
$('fac-file').onchange = async e => {
  const file = e.target.files[0]; e.target.value = '';
  if (!file) return;
  let j; try { j = JSON.parse(await file.text()); } catch (_) { return alert('JSON として読めなかった'); }
  const locs = j.locations || (j.zissyu && j.zissyu.locations);
  j = null;  // 学生の行はここで手放す
  if (!locs) return alert('この控えに施設（locations）が見当たらない');
  importLocs(locs);
};
async function importLocs(locs) {
  const groups = {};
  Object.values(locs).forEach(l => {
    if (!l || !l.name) return;
    const g = groups[l.name] = groups[l.name] || { name: l.name, address: l.address || '', pediatric: !!l.isPediatric, time: l.time || '', cap: { 評価: 0, 総合: 0, 見学: 0 } };
    TYPES.forEach(t => { if (String(l.type || '').includes(t)) g.cap[t]++; });
    if (l.isPediatric) g.pediatric = true;
  });
  const list = Object.values(groups);
  if (!confirm(`施設 ${list.length}件を取り込む。\n（同じ名前の施設は住所・小児だけ上書き。受入人数と始業は${S.year}年度に入れる）\n学生・住所・計算結果は読まずに捨てる。`)) return;
  const byName = {}; Object.entries(S.facilities).forEach(([k, f]) => byName[f.name] = k);
  const up = {};
  list.forEach(g => {
    const id = byName[g.name] || newId();
    const f = { ...(S.facilities[id] || {}), name: g.name, address: g.address, pediatric: g.pediatric };
    up['facilities/' + id] = f;
    up[ypath('facilities/' + id)] = { cap: g.cap, start: normTime(g.time) || '08:30' };
  });
  await db.ref().update(up).catch(fail);
  toast(list.length + '施設を取り込んだ。次は「駅の下書きを出す」');
}
function normTime(t) { const m = String(t || '').match(/(\d{1,2})[:：時](\d{2})?/); return m ? String(+m[1]).padStart(2, '0') + ':' + (m[2] || '00') : ''; }

// OpenStreetMap（Overpass）から施設の近くの駅・バス停・電停（直線距離の近い順に4つ）。
// 返事が来ないことがある＝8秒で諦めて空で返す（Google の候補だけで決まる）。2回続けて来なければその回はもう聞かない
const OVERPASS = ['https://overpass-api.de/api/interpreter', 'https://overpass.private.coffee/api/interpreter'];
let osmMiss = 0;
async function osmStops(p) {
  if (osmMiss >= 2) return [];
  const a = `(around:1500,${p.lat},${p.lng})`;
  const q = `[out:json][timeout:8];(nwr${a}[railway~"^(station|halt|tram_stop)$"];nwr${a}[highway=bus_stop];nwr${a}[public_transport=platform][bus=yes];);out center tags;`;
  for (const url of OVERPASS) {
    try {
      const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 8000);
      const r = await fetch(url, { method: 'POST', body: new URLSearchParams({ data: q }), signal: ctl.signal });
      clearTimeout(t);
      if (!r.ok) continue;
      const d = await r.json(); osmMiss = 0;
      const by = {};
      (d.elements || []).forEach(e => {
        const tg = e.tags || {}, name = tg['name:ja'] || tg.name;
        const lat = e.lat != null ? e.lat : (e.center || {}).lat, lng = e.lon != null ? e.lon : (e.center || {}).lon;
        if (!name || lat == null) return;
        const kind = tg.railway === 'tram_stop' || tg.tram === 'yes' ? '路面電車'
          : (tg.railway === 'station' || tg.railway === 'halt') ? (tg.station === 'subway' || tg.subway === 'yes' ? '地下鉄' : '電車') : 'バス';
        const dx = (lng - p.lng) * Math.cos(p.lat * Math.PI / 180), dy = lat - p.lat, dist = dx * dx + dy * dy;
        const key = kind + '|' + name;
        if (!by[key] || dist < by[key].dist) by[key] = { name, kind, lat, lng, dist };
      });
      return Object.values(by).sort((x, y) => x.dist - y.dist).slice(0, 4).map(({ name, kind, lat, lng }) => ({ name, kind, lat, lng }));
    } catch (_) {}
  }
  osmMiss++;
  return [];
}

// 駅の下書き（駅が空で住所がある施設）
$('fac-draft').onclick = async () => {
  // 駅が空の施設と、まだ「駅は下書き」のままの施設（先生が直した駅は触らない）
  const todo = Object.keys(S.facilities).filter(fid => (!S.facilities[fid].station || S.facilities[fid].draft) && S.facilities[fid].address);
  if (!todo.length) return toast('駅が空・下書きのままの施設は無い');
  if (!confirm(`${todo.length}施設の最寄り（施設から歩いて一番近い駅・バス停・電停）を下書きする（駅が空の施設と「駅は下書き」のままの施設。先生が直した駅は触らない）`)) return;
  busy(true, '駅を探している…');
  let ok = 0; const errs = {}; const okayama = [];
  try {
    for (let i = 0; i < todo.length; i += 5) {   // 1件で地図に10回あまり聞く＝GASの6分に収まるよう5件ずつ
      const part = todo.slice(i, i + 5);
      const geos = await gas('geo', part.map(fid => ({ address: S.facilities[fid].address })));
      const jobs = [];
      for (let k = 0; k < part.length; k++) {
        const here = geos[k] && geos[k].lat != null ? geos[k] : null;
        const cands = here ? await osmStops(here) : [];
        jobs.push({ address: S.facilities[part[k]].address, arrive: startOf(part[k]), here, cands });
      }
      const res = await gas('station', jobs);
      const up = {};
      part.forEach((fid, k) => {
        const r = res[k] || {};
        if (r.walkOnly) okayama.push(S.facilities[fid].name || fid);
        if (r.station) ok++; else { const m = r.err || '返事なし'; (errs[m] = errs[m] || []).push(S.facilities[fid].name || fid); }
        if (r.station) Object.assign(up, { [`facilities/${fid}/station`]: r.station, [`facilities/${fid}/stopKind`]: r.kind || null, [`facilities/${fid}/stopLoc`]: r.loc || null,
          [`facilities/${fid}/draft`]: true, [`facilities/${fid}/walk`]: r.walk ?? null, [`facilities/${fid}/bike`]: r.bike ?? null, [`facilities/${fid}/access`]: null });
      });
      await db.ref().update(up);
      busy(true, `駅を探している… ${Math.min(i + 5, todo.length)}/${todo.length}`);
    }
    const ng = Object.keys(errs);
    const oka = okayama.length ? `\n\n岡山駅から歩きの経路しか出なかった ${okayama.length}件（駅は「岡山」で入れた・確かめる）：${okayama.join('、')}` : '';
    if (ng.length || oka) {
      busy(false);
      alert(`下書きできた ${ok}件／できなかった ${todo.length - ok}件` + oka + (ng.length ? '\n\n' : '') + ng.map(m => `【${m}】${errs[m].length}件：${errs[m].slice(0, 5).join('、')}${errs[m].length > 5 ? ' ほか' : ''}`).join('\n'));
    } else toast(`下書きした ${ok}件（駅・バス停・電停）。「駅は下書き」の印の施設を確かめて直す`);
  } catch (e) { fail(e); }
  busy(false);
};

// ===== 2. 学生 =====
function renderStu() {
  const sids = Object.keys(students()).sort();
  let h = `<tr><th>学籍番号</th><th>名前</th><th>実習</th><th>小児</th><th>ふだんの駅</th><th>駅まで</th><th>車で直接</th><th>実家から</th><th>確認票</th></tr>`;
  if (!sids.length) h += `<tr><td colspan="9" class="hint">まだ学生がいない。確認票を回収したら「表から貼り付け」か「学生を足す」。</td></tr>`;
  for (const sid of sids) {
    const s = students()[sid], jk = s.jk || {};
    h += `<tr class="clk" data-sid="${esc(sid)}"><td>${esc(sid)}</td><td>${esc(s.name)}<span class="hint"> ${esc(s.grade || '')}</span></td>
      <td>${TYPES.filter(t => (s.t || {})[t]).join('・')}</td><td>${s.ped ? '希望' : ''}</td>
      <td>${s.st ? esc(stName(s.st)) : '<span class="tag red">未</span>'}</td><td>${s.min != null ? esc(s.mode || '') + s.min + '分' : ''}</td>
      <td>${s.carDirect ? '可' : ''}</td><td>${jk.ok ? '可：' + esc(stName(jk.st || '?')) + (jk.min != null ? '（' + esc(jk.mode || '') + jk.min + '分）' : '') : ''}</td>
      <td>${s.slip ? esc(s.slip) : '<span class="tag yel">未回収</span>'}</td></tr>`;
  }
  $('stu-table').innerHTML = h;
}
$('stu-table').onclick = e => { const tr = e.target.closest('tr[data-sid]'); if (tr) openStu(tr.dataset.sid); };
$('stu-add').onclick = () => openStu(null);

function openStu(sid) {
  const s = sid ? students()[sid] : {}, jk = s.jk || {};
  const fm = $('f-stu'); fm.reset();
  fm.sid.value = sid || ''; fm.sid.readOnly = !!sid;
  ['name', 'grade', 'min', 'slip', 'past'].forEach(k => fm[k].value = s[k] == null ? '' : s[k]);
  fm.st.value = stName(s.st || '');
  fm.mode.value = s.mode || '徒歩';
  TYPES.forEach(t => fm['t' + t].checked = !!(s.t || {})[t]);
  fm.ped.checked = !!s.ped; fm.carDirect.checked = !!s.carDirect;
  fm.jkOk.value = jk.ok ? '1' : ''; fm.jkSt.value = stName(jk.st || ''); fm.jkMode.value = jk.mode || '徒歩'; fm.jkMin.value = jk.min == null ? '' : jk.min;
  $('stu-del').style.display = sid ? '' : 'none';
  $('stu-del').onclick = async () => {
    if (!confirm(`${s.name}を${S.year}年度から消す？（この年度の配置と車の分数も消える）`)) return;
    const up = { [ypath('students/' + sid)]: null, [ypath('car/' + sid)]: null };
    TYPES.forEach(t => up[ypath(`assignments/${t}/${sid}`)] = null);
    await db.ref().update(up).catch(fail); $('dlg-stu').close();
  };
  $('dlg-stu').onclose = async () => {
    if ($('dlg-stu').returnValue !== 'ok') return;
    const id = fk(fm.sid.value);
    if (!id) return;
    if (!sid && students()[id] && !confirm(`${id} はもういる。上書きする？`)) return;
    const t = {}; TYPES.forEach(x => t[x] = fm['t' + x].checked);
    const rec = {
      name: fm.name.value.trim(), grade: fm.grade.value.trim(), t, ped: fm.ped.checked,
      st: stName(fm.st.value), mode: fm.mode.value, min: num(fm.min.value), carDirect: fm.carDirect.checked,
      jk: { ok: fm.jkOk.value === '1', st: stName(fm.jkSt.value), mode: fm.jkMode.value, min: num(fm.jkMin.value) },
      slip: fm.slip.value.trim(), past: fm.past.value.trim(),
    };
    await db.ref(ypath('students/' + id)).set(rec).catch(fail);
    toast('保存した');
  };
  $('dlg-stu').returnValue = '';
  $('dlg-stu').showModal();
}

const STU_COLS = ['学籍番号', '名前', '学年', '評価', '総合', '見学', '小児希望', 'ふだんの駅', '駅までの手段', '駅までの分', '車で直接', '実家から可', '実家の駅', '実家の手段', '実家の分', '確認票回収日', '過去の実習先'];
$('stu-paste').onclick = () => openPaste('学生を表から貼り付け', '列の順：' + STU_COLS.join('・') + '。○/1/可 を「はい」と読む。住所の列は作らない。同じ学籍番号はその行で上書き。', async rows => {
  const up = {}; let n = 0;
  for (const r of rows) {
    if (!r[0] || r[0] === '学籍番号') continue;
    const id = fk(r[0]);
    const s = { ...(students()[id] || {}) };
    const g = i => (r[i] === undefined ? '' : String(r[i]).trim());
    if (g(1)) s.name = g(1);
    if (g(2)) s.grade = g(2);
    s.t = { ...(s.t || {}) }; TYPES.forEach((t, i) => { if (g(3 + i)) s.t[t] = yes(g(3 + i)); });
    if (g(6)) s.ped = yes(g(6));
    if (g(7)) s.st = stName(g(7));
    if (g(8)) s.mode = MODES.includes(g(8)) ? g(8) : '徒歩';
    if (g(9)) s.min = num(g(9));
    if (g(10)) s.carDirect = yes(g(10));
    s.jk = { ...(s.jk || {}) };
    if (g(11)) s.jk.ok = yes(g(11));
    if (g(12)) s.jk.st = stName(g(12));
    if (g(13)) s.jk.mode = MODES.includes(g(13)) ? g(13) : '徒歩';
    if (g(14)) s.jk.min = num(g(14));
    if (g(15)) s.slip = g(15);
    if (g(16)) s.past = g(16);
    up[ypath('students/' + id)] = s; n++;
  }
  await db.ref().update(up); toast(n + '人を取り込んだ');
});
$('stu-tpl').onclick = () => {
  const ex = ['S0001', '学生A', '3年', '○', '', '', '', '倉敷', '自転車', '10', '', '可', '新見', '車', '15', '2026-11-05', ''];
  const csv = '﻿' + [STU_COLS, ex].map(r => r.join(',')).join('\r\n');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' })); a.download = '学生_貼り付け見本.csv'; a.click();
};

// 貼り付けの共通
function openPaste(title, hint, onOk) {
  $('paste-title').textContent = title; $('paste-hint').textContent = hint; $('paste-text').value = '';
  const d = $('dlg-paste'); d.returnValue = '';
  d.onclose = async () => {
    if (d.returnValue !== 'ok') return;
    const rows = $('paste-text').value.split(/\r?\n/).filter(l => l.trim()).map(l => l.split(l.includes('\t') ? '\t' : ',').map(c => c.trim()));
    try { await onOk(rows); } catch (e) { fail(e); }
  };
  d.showModal();
}

// ===== 3. 計算 =====
function neededJobs() {
  const walk = [], transit = {}; let missing = { st: 0, fac: 0 };
  for (const fid of Object.keys(S.facilities)) {
    const f = S.facilities[fid];
    if (f.station && f.address && (f.access || '徒歩') === '徒歩' && f.walk == null) walk.push(fid);
  }
  for (const t of TYPES) {
    for (const sid of studsOf(t)) {
      const bs = bases(students()[sid]);
      if (!bs.length) { missing.st++; continue; }
      for (const fid of facsOf(t)) {
        const f = S.facilities[fid], arr = arriveBy(fid);
        if (!f.station || !arr) { missing.fac++; continue; }
        for (const b of bs) {
          const key = rKey(b.st, f.station, arr);
          if (!S.routes[key]) transit[key] = { from: stName(b.st), to: stName(f.station), toLoc: f.stopLoc || null, arrive: arr };
        }
      }
    }
  }
  return { walk, transit, missing };
}
function renderCalc() {
  const j = neededJobs(), nT = Object.keys(j.transit).length;
  const errN = Object.values(S.routes).filter(r => r && r.err).length;
  $('calc-summary').innerHTML = `
    <div>まだ計算していない：<b>駅→駅 ${nT}件</b>／施設の駅からの徒歩 ${j.walk.length}件</div>
    <div class="hint" style="margin:6px 0 0">保存済みの駅→駅 ${Object.keys(S.routes).length}件（うち経路なし ${errN}件）。
    ${j.missing.st ? `<span class="tag red">駅か分数が空の学生がいる</span>` : ''}${j.missing.fac ? `<span class="tag red">駅か駅からの時間が空の施設がある</span>` : ''}
    ${S.settings.gasUrl ? '' : '<span class="tag red">設定で GAS の URL を入れる</span>'}</div>`;
  renderCar();
}
async function gas(action, jobs) {
  if (!S.settings.gasUrl) throw new Error('設定で経路計算（GAS）の URL を入れる');
  const idToken = await auth.currentUser.getIdToken();
  const r = await fetch(S.settings.gasUrl, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: JSON.stringify({ action, jobs, idToken }) });
  const j = await r.json();
  if (j.status !== 'OK') throw new Error(j.message || 'GAS のエラー');
  return j.results;
}
$('calc-stop').onclick = () => { S.calcStop = true; };
$('calc-retry').onclick = async () => {
  const keys = Object.keys(S.routes).filter(k => S.routes[k] && S.routes[k].err);
  if (!keys.length) return toast('経路なしの分は無い');
  if (!confirm(`経路なしの ${keys.length}件を消してやり直す？（駅名を直してからが良い）`)) return;
  const up = {}; keys.forEach(k => up['routes/' + k] = null);
  await db.ref().update(up).catch(fail); $('calc-run').click();
};
$('calc-run').onclick = async () => {
  if (S.calcing) return;
  S.calcing = true; S.calcStop = false; $('calc-run').disabled = true; $('calc-stop').disabled = false;
  const msg = $('calc-msg'), bar = $('calc-bar');
  try {
    // ③ 施設の駅から徒歩
    let j = neededJobs();
    const all = j.walk.length + Object.keys(j.transit).length; let done = 0;
    const step = n => { done += n; bar.style.width = (all ? done / all * 100 : 100) + '%'; msg.textContent = `${done} / ${all}`; };
    for (let i = 0; i < j.walk.length && !S.calcStop; i += 10) {
      const part = j.walk.slice(i, i + 10);
      const res = await gas('walk', part.map(fid => ({ station: S.facilities[fid].station, loc: S.facilities[fid].stopLoc || null, address: S.facilities[fid].address })));
      const up = {};
      part.forEach((fid, k) => { const r = res[k] || {}; if (r.walk != null) { up[`facilities/${fid}/walk`] = r.walk; up[`facilities/${fid}/bike`] = r.bike; Object.assign(S.facilities[fid], { walk: r.walk, bike: r.bike }); } });
      await db.ref().update(up); step(part.length);
    }
    // ② 駅→駅（徒歩が出たので必要な分を出し直す）
    j = neededJobs();
    const keys = Object.keys(j.transit);
    for (let i = 0; i < keys.length && !S.calcStop; i += 10) {
      const part = keys.slice(i, i + 10);
      const res = await gas('transit', part.map(k => j.transit[k]));
      const up = {};
      part.forEach((k, n) => { const r = res[n] || { err: '応答なし' }; up['routes/' + k] = S.routes[k] = { ...r, from: j.transit[k].from, to: j.transit[k].to, arrive: j.transit[k].arrive, at: now() }; });
      await db.ref().update(up); step(part.length);
    }
    msg.textContent = S.calcStop ? `止めた（${done}件まで保存済み）` : `終わった（${done}件）`;
    bar.style.width = '100%';
  } catch (e) { fail(e); msg.textContent = '途中で止まった。もう一度押せば続きから。'; }
  S.calcing = false; $('calc-run').disabled = false; $('calc-stop').disabled = true; renderCalc();
};

// 車で直接（住所は入力欄の中だけ・保存しない）
function renderCar() {
  const box = $('car-box');
  if (box.contains(document.activeElement) && document.activeElement.tagName === 'INPUT') return; // 入力中は描き直さない
  const sids = Object.keys(students()).filter(sid => students()[sid].carDirect).sort();
  const carFacs = Object.keys(S.facilities).filter(fid => S.facilities[fid].carOk && S.facilities[fid].address && TYPES.some(t => num(((yFac(fid).cap) || {})[t]) > 0));
  if (!sids.length) { box.innerHTML = '<div class="hint" style="margin:0">「車で直接」の学生はいない。</div>'; return; }
  box.innerHTML = `<div class="hint" style="margin:0 0 6px">車通勤可の施設：${carFacs.length}件</div>` + sids.map(sid => {
    const n = Object.keys(((Y().car || {})[sid]) || {}).length;
    return `<div class="car-row" data-sid="${esc(sid)}"><span class="nm">${esc(students()[sid].name)}</span>
      <input type="text" autocomplete="off" placeholder="住所（保存しない）"><button class="small">計算</button>
      <span class="hint" style="margin:0">計算済み ${n}/${carFacs.length}</span></div>`;
  }).join('');
}
$('car-box').onclick = async e => {
  const b = e.target.closest('button'); if (!b) return;
  const row = b.closest('.car-row'), sid = row.dataset.sid, inp = row.querySelector('input');
  const from = inp.value.trim(); if (!from) return toast('住所を入れる');
  const fids = Object.keys(S.facilities).filter(fid => S.facilities[fid].carOk && S.facilities[fid].address && TYPES.some(t => num(((yFac(fid).cap) || {})[t]) > 0));
  busy(true, '車の時間を計算中…');
  try {
    const up = {};
    for (let i = 0; i < fids.length; i += 10) {
      const part = fids.slice(i, i + 10);
      const res = await gas('car', part.map(fid => ({ from, to: S.facilities[fid].address, arrive: startOf(fid) })));
      part.forEach((fid, k) => { if (res[k] && res[k].car != null) up[ypath(`car/${sid}/${fid}`)] = res[k].car; });
    }
    await db.ref().update(up);
    inp.value = '';
    toast('保存した（住所は消した）');
  } catch (err) { fail(err); }
  busy(false);
};

// ===== 4. 割り振り =====
function renderAsg() {
  const t = S.type, lock = (Y().locks || {})[t];
  $('asg-tabs').innerHTML = TYPES.map(x => `<button data-t="${x}" class="${x === t ? 'on' : ''}">${x}</button>`).join('') +
    `<span class="spacer"></span>` + (lock ? `<span class="locked">確定：${esc(lock.by)}　${fmtAt(lock.at)}</span><button class="small" id="asg-unlock">確定を外す</button>` : `<button class="primary small" id="asg-lock">この種別を確定する</button>`);
  const sids = studsOf(t), fids = facsOf(t), A = asg(t);
  const evs = {}; sids.forEach(sid => { evs[sid] = {}; fids.forEach(fid => evs[sid][fid] = evalPair(sid, fid)); });
  S._evs = evs;

  // 上の数字
  const placed = sids.filter(sid => A[sid] && S.facilities[A[sid].fid]);
  let stay = 0, longest = null, longestWho = '';
  placed.forEach(sid => { const ev = evs[sid][A[sid].fid] || evalPair(sid, A[sid].fid); if (isStay(ev)) stay++; if (ev.best && (longest == null || ev.best.total > longest)) { longest = ev.best.total; longestWho = students()[sid].name; } });
  $('asg-stats').innerHTML = `<div><span class="k">決まった人</span><b>${placed.length}</b> / ${sids.length}</div>
    <div><span class="k">宿泊になる配置</span><b style="color:${stay ? 'var(--bad)' : 'inherit'}">${stay}</b>件</div>
    <div><span class="k">いちばん長い片道</span><b>${fmtMin(longest)}</b> <span class="hint">${esc(longestWho)}</span></div>
    <div><span class="k">施設（受入あり）</span><b>${fids.length}</b></div>`;

  // 施設の埋まり具合
  const cnt = {}; placed.forEach(sid => cnt[A[sid].fid] = (cnt[A[sid].fid] || 0) + 1);
  $('asg-fill').innerHTML = fids.map(fid => { const cap = num(yFac(fid).cap[t]), c = cnt[fid] || 0; return `<span class="${c > cap ? 'over' : c === cap ? 'full' : ''}">${esc(S.facilities[fid].name)} ${c}/${cap}</span>`; }).join('');

  // 学生の一覧
  const reach = sid => fids.filter(fid => !isStay(evs[sid][fid])).length;
  let order = [...sids];
  if (S.sort === 'id') order.sort();
  else if (S.sort === 'few') order.sort((a, b) => reach(a) - reach(b) || a.localeCompare(b));
  else order.sort((a, b) => (!!A[a] - !!A[b]) || reach(a) - reach(b) || a.localeCompare(b));
  if (!S.sel || !sids.includes(S.sel)) S.sel = order[0] || null;
  $('asg-list').innerHTML = order.map(sid => {
    const s = students()[sid], a = A[sid], f = a && S.facilities[a.fid];
    let sub = `通える施設 ${reach(sid)}`;
    if (f) { const ev = evs[sid][a.fid]; const mk = mark(ev.best && ev.best.total); sub = `<span class="mk ${mk.c}">${mk.m}</span>${esc(f.name)} ${fmtMin(ev.best && ev.best.total)}`; }
    return `<div class="it ${sid === S.sel ? 'sel' : ''}" data-sid="${esc(sid)}"><div class="nm">${esc(s.name)}${s.ped ? '<span class="tag blu">小児希望</span>' : ''}${bases(s).length ? '' : '<span class="tag red">駅が未入力</span>'}</div><div class="sub">${sub}</div></div>`;
  }).join('') || '<div class="it hint">この種別の学生がいない（学生の画面で「この年度の実習」に印）</div>';

  renderCands(fids, evs, A, cnt, lock);
}

// 施設ごとに「宿泊なしで通える学生」
function reachersOf(fid, evs) { return Object.keys(evs).filter(sid => evs[sid][fid] && !isStay(evs[sid][fid])); }

function renderCands(fids, evs, A, cnt, lock) {
  const sid = S.sel, box = $('asg-cands');
  if (!sid) { box.innerHTML = ''; return; }
  const s = students()[sid], cur = A[sid], past = pastOf(sid), t = S.type;
  const rows = fids.map(fid => {
    const ev = evs[sid][fid], f = S.facilities[fid], cap = num(yFac(fid).cap[t]);
    const used = (cnt[fid] || 0) - (cur && cur.fid === fid ? 1 : 0);
    const full = used >= cap, wasPast = past.has(fid);
    return { fid, ev, f, full, wasPast, warned: full || wasPast };
  });
  const sortKey = r => r.ev.best ? (isStay(r.ev) ? 10000 : 0) + r.ev.best.total : 20000;
  rows.sort((a, b) => (a.warned - b.warned) || sortKey(a) - sortKey(b));
  const curF = cur && S.facilities[cur.fid];
  let h = `<div class="curbox"><b>${esc(s.name)}</b> <span class="hint">${esc(sid)}</span>
    <div class="hint" style="margin:4px 0 0">ふだん：${s.st ? esc(stName(s.st)) + '駅（' + esc(s.mode || '') + (s.min != null ? s.min + '分' : '?') + '）' : '未入力'}
    ${s.jk && s.jk.ok ? '／実家から可：' + esc(stName(s.jk.st || '?')) + '駅' : ''}${s.carDirect ? '／車で直接可' : ''}${s.ped ? '／小児希望' : ''}</div>
    ${curF ? `<div style="margin-top:6px">配置：<b>${esc(curF.name)}</b> <span class="hint">${esc(cur.by || '')} ${fmtAt(cur.at)}${cur.reason ? '／変更の理由：' + esc(cur.reason) : ''}</span>
      <button class="small danger" data-act="remove">外す</button></div>` : ''}</div>`;
  h += `<table class="cands"><tr><th></th><th>施設</th><th class="num">片道</th><th>内訳</th><th>印</th><th></th></tr>`;
  let sepDone = false;
  for (const r of rows) {
    if (r.warned && !sepDone) { h += `<tr class="sep"><td colspan="6">受入がいっぱい・過去に行った施設（選べるが警告つき）</td></tr>`; sepDone = true; }
    const b = r.ev.best, mk = mark(b && b.total);
    let brk = '';
    if (b && b.k === '車') brk = '車で直接';
    else if (b) brk = `${b.k === '実家' ? '実家から：' : ''}①${esc(b.b.mode)}${b.b.min} ＋ ②電車・バス${b.r.ride}${b.r.transfers ? '（乗換' + b.r.transfers + '）' : ''} ＋ ③${esc(r.f.access && r.f.access !== '徒歩' ? r.f.access : '徒歩')}${b.l3}`;
    else if (r.ev.errs.length) brk = esc(r.ev.errs.join('／'));
    else brk = '未計算';
    const tags = [];
    if (b && b.k === '実家') tags.push('<span class="tag grn">実家から</span>');
    if (b && b.r && b.r.shinkansen) tags.push('<span class="tag yel">新幹線</span>');
    if (r.full) tags.push('<span class="tag">受入いっぱい</span>');
    if (r.wasPast) tags.push('<span class="tag">過去に行った</span>');
    if (s.ped && !r.f.pediatric) tags.push('<span class="tag yel">小児でない</span>');
    if (isStay(r.ev) && b) tags.push('<span class="tag red">宿泊</span>');
    const rc = reachersOf(r.fid, evs);
    if (rc.length && rc.length <= 3) tags.push(`<span class="tag blu" title="宿泊なしで通えるのは ${esc(rc.map(x => students()[x].name).join('、'))}">通えるのは${rc.length}人</span>`);
    else if (!rc.length && Object.keys(evs).length) tags.push('<span class="tag">誰も宿泊なしでは通えない</span>');
    const prop = r.ev.prop != null && r.ev.prop < b.total ? `<div class="prop">駅に自転車を置けば 約${r.ev.prop}分</div>` : '';
    h += `<tr class="${r.warned ? 'warned' : ''} ${cur && cur.fid === r.fid ? 'cur' : ''}"><td><span class="mk ${mk.c}">${mk.m}</span></td>
      <td>${esc(r.f.name)}${r.f.pediatric ? '<span class="tag blu">小児</span>' : ''}</td>
      <td class="num tot">${fmtMin(b && b.total)}</td><td class="brk">${brk}${prop}</td><td>${tags.join('')}</td>
      <td style="white-space:nowrap"><button class="small" data-act="detail" data-fid="${r.fid}">詳細</button>
      ${cur && cur.fid === r.fid ? '' : `<button class="small primary" data-act="place" data-fid="${r.fid}">配置</button>`}</td></tr>`;
  }
  if (!rows.length) h += `<tr><td colspan="6" class="hint">この種別で受入人数が入っている施設が無い（施設の画面で受入人数を入れる）</td></tr>`;
  h += '</table>';
  box.innerHTML = h;
}

$('asg-tabs').onclick = async e => {
  const b = e.target.closest('button'); if (!b) return;
  if (b.dataset.t) { S.type = b.dataset.t; S.sel = null; return renderAsg(); }
  if (b.id === 'asg-lock' && confirm(`${S.type}の割り振りを確定する？（このあと変えるときは理由を書く）`)) await db.ref(ypath('locks/' + S.type)).set({ by: me(), at: now() }).catch(fail);
  if (b.id === 'asg-unlock' && confirm('確定を外す？')) await db.ref(ypath('locks/' + S.type)).remove().catch(fail);
};
$('asg-sort').onchange = e => { S.sort = e.target.value; renderAsg(); };
$('asg-list').onclick = e => { const it = e.target.closest('.it[data-sid]'); if (it) { S.sel = it.dataset.sid; renderAsg(); } };
$('asg-cands').onclick = async e => {
  const b = e.target.closest('button[data-act]'); if (!b) return;
  const sid = S.sel, t = S.type, lock = (Y().locks || {})[t], cur = asg(t)[sid];
  if (b.dataset.act === 'detail') return openDetail(sid, b.dataset.fid);
  let reason = '';
  if (lock) { reason = prompt('確定済み。変える理由を1行で'); if (!reason) return; }
  const path = ypath(`assignments/${t}/${sid}`);
  try {
    if (b.dataset.act === 'remove') {
      if (!lock && !confirm('外す？')) return;
      if (lock) await db.ref(ypath(`changes/${t}`)).push({ sid, from: cur && cur.fid, to: null, by: me(), at: now(), reason });
      await db.ref(path).remove();
    } else if (b.dataset.act === 'place') {
      const fid = b.dataset.fid, ev = evalPair(sid, fid);
      if (ev.best && ev.best.total > S.settings.rule && !confirm(`片道 ${fmtMin(ev.best.total)}。規則の上限（${S.settings.rule}分）を超える。それでも置く？`)) return;
      if (lock) await db.ref(ypath(`changes/${t}`)).push({ sid, from: cur && cur.fid || null, to: fid, by: me(), at: now(), reason });
      await db.ref(path).set({ fid, by: me(), at: now(), reason: reason || null, stay: isStay(ev) });
    }
  } catch (err) { fail(err); }
};

function openDetail(sid, fid) {
  const s = students()[sid], f = S.facilities[fid], ev = evalPair(sid, fid);
  let h = `<h2 style="margin-top:0">${esc(s.name)} → ${esc(f.name)}</h2><p class="hint">始業 ${esc(startOf(fid))}・駅に着く時刻 ${arriveBy(fid) || '?'}（③${leg3(f) ?? '?'}分＋ゆとり${S.settings.yutori}分を引いた）</p>`;
  if (!ev.opts.length) h += `<p>${ev.errs.length ? esc(ev.errs.join('／')) : 'まだ計算していない（3. 計算）'}</p>`;
  for (const o of ev.opts) {
    const mk = mark(o.total);
    h += `<div class="box"><b><span class="mk ${mk.c}">${mk.m}</span> ${o.k === '車' ? '車で直接' : o.k + 'の駅から'}：${fmtMin(o.total)}</b>`;
    if (o.k !== '車') {
      h += `<table class="dt" style="margin-top:6px">
        <tr><td>① 駅まで</td><td>${esc(stName(o.b.st))}駅まで ${esc(o.b.mode)} ${o.b.min}分（本人の申告）</td></tr>
        <tr><td>② 電車・バス</td><td>${o.r.ride}分（${esc(o.r.dep)}発→${esc(o.r.arr)}着・乗換${o.r.transfers}回${o.r.shinkansen ? '・新幹線' : ''}）<div class="hint" style="margin:2px 0 0">${esc(o.r.lines)}</div>
          ${o.r.fromAddr ? `<div class="hint" style="margin:0">Maps が読んだ駅：${esc(o.r.fromAddr)} → ${esc(o.r.toAddr)}</div>` : ''}</td></tr>
        <tr><td>③ 施設の駅から</td><td>${esc(stName(f.station))}${f.stopKind && f.stopKind !== '電車' ? '（' + esc(f.stopKind) + '）' : '駅'}から ${esc(f.access || '徒歩')} ${o.l3}分</td></tr></table>`;
    } else h += `<div class="hint">本人の住所から車（住所は保存していない）</div>`;
    h += `</div>`;
  }
  if (ev.prop != null) h += `<p class="prop" style="color:var(--ok)">駅に自転車を置けば 約${ev.prop}分（③を自転車${f.bike}分にした目安）</p>`;
  $('detail-body').innerHTML = h; $('dlg-detail').showModal();
}
$('detail-close').onclick = () => $('dlg-detail').close();

// ===== 5. 印刷 =====
function slipHtml(sid, s) {
  const opt = arr => arr.map(x => `<span class="ck2"><span class="bx"></span>${x}</span>`).join('');
  return `<div class="pg slip"><h1>実習の通学 確認票</h1>
    <div class="meta"><span>${esc(S.year)}年度</span><span>学籍番号 ${sid ? esc(sid) : '<span class="ln s"></span>'}</span><span>名前 ${s ? esc(s.name) : '<span class="ln"></span>'}</span></div>
    <div class="q"><div class="t">1. ふだん使う駅（正式な駅名）</div><span class="ln"></span> 駅
      <p class="note">実習中に乗る駅を書く。地図で一番近い駅でなくてよい（ふだん使っている駅）。</p></div>
    <div class="q"><div class="t">2. その駅までの手段と時間</div>${opt(MODES)}<br>家を出てから駅のホームまで　約 <span class="ln s"></span> 分</div>
    <div class="q"><div class="t">3. 車で実習先まで直接通えますか（自分で運転・車を使える）</div>${opt(['はい', 'いいえ'])}</div>
    <div class="q"><div class="t">4. 実家からの実習</div>${opt(['可（実家から通ってもよい）', '不可'])}
      <div>「可」のとき：実家の最寄り駅 <span class="ln"></span> 駅　手段 ${opt(MODES)}　約 <span class="ln s"></span> 分</div>
      <p class="note">住所は書かない（学校がすでに持っている）。</p></div>
    <div class="sign">実習中は、上の駅・方法で通います。<br>
      記入日　　　　年　　月　　日　　　　本人の署名 <span class="ln"></span></div>
    <p class="note" style="margin-top:6mm">先生記入欄：回収日　　　月　　日　　確認者 ________</p></div>`;
}
function doPrint(html) { $('print-area').innerHTML = html; setTimeout(() => window.print(), 50); }
$('prt-slip').onclick = () => {
  const sids = Object.keys(students()).sort();
  if (!sids.length) return toast('この年度の学生がいない（名前なしの白紙なら刷れる）');
  doPrint(sids.map(sid => slipHtml(sid, students()[sid])).join(''));
};
$('prt-slip-blank').onclick = () => doPrint(slipHtml('', null));
document.querySelector('#v-prt').addEventListener('click', e => {
  const b = e.target.closest('button[data-list]'); if (!b) return;
  const ts = b.dataset.list === 'all' ? TYPES : [b.dataset.list];
  doPrint(ts.map(listHtml).join(''));
});
function listHtml(t) {
  const A = asg(t), fids = facsOf(t), lock = (Y().locks || {})[t];
  let h = `<div class="pg list"><h1>${esc(S.year)}年度 ${t}実習 配置一覧</h1><div class="meta">${lock ? '確定：' + esc(lock.by) + ' ' + fmtAt(lock.at) : '（未確定）'}　印刷：${fmtAt(now())}</div>
    <table><tr><th>施設</th><th>駅</th><th>始業</th><th>学生</th><th class="num">片道</th><th>内訳</th><th>印</th></tr>`;
  for (const fid of fids) {
    const f = S.facilities[fid], who = Object.keys(A).filter(sid => A[sid].fid === fid && students()[sid]);
    if (!who.length) { h += `<tr><td>${esc(f.name)}</td><td>${esc(stName(f.station || ''))}</td><td>${esc(startOf(fid))}</td><td colspan="4" style="color:#888">（なし）</td></tr>`; continue; }
    who.forEach((sid, i) => {
      const ev = evalPair(sid, fid), b = ev.best, mk = mark(b && b.total);
      const brk = !b ? '' : b.k === '車' ? '車で直接' : `${b.k === '実家' ? '実家・' : ''}${stName(b.b.st)}駅 ${b.b.mode}${b.b.min}＋電車${b.r.ride}＋${b.l3}`;
      h += `<tr>${i === 0 ? `<td rowspan="${who.length}">${esc(f.name)}</td><td rowspan="${who.length}">${esc(stName(f.station || ''))}</td><td rowspan="${who.length}">${esc(startOf(fid))}</td>` : ''}
        <td>${esc(students()[sid].name)}</td><td class="num">${fmtMin(b && b.total)}</td><td>${esc(brk)}</td><td>${mk.m}${b && b.r && b.r.shinkansen ? ' 新幹線' : ''}${isStay(ev) ? ' 宿泊' : ''}</td></tr>`;
    });
  }
  const un = studsOf(t).filter(sid => !A[sid] || !S.facilities[A[sid].fid]);
  if (un.length) h += `<tr><td colspan="7"><b>未配置：</b>${un.map(sid => esc(students()[sid].name)).join('、')}</td></tr>`;
  return h + '</table></div>';
}

// ===== 先生 =====
function renderTch() {
  $('tch-table').innerHTML = `<tr><th>メール</th><th>名前</th><th>登録</th><th></th></tr>` + Object.entries(S.teachers).map(([uid, t]) =>
    `<tr><td>${esc(t.email)}</td><td>${esc(t.name || '')}</td><td>${fmtAt(t.at)}</td><td>${uid === S.user.uid ? '<span class="hint">自分</span>' : `<button class="small danger" data-uid="${esc(uid)}">外す</button>`}</td></tr>`).join('');
  const inv = Object.entries(S.invites);
  $('inv-table').innerHTML = `<tr><th>メール</th><th>招待した人</th><th>日時</th><th></th></tr>` + (inv.length ? inv.map(([k, v]) =>
    `<tr><td>${esc(v.email)}</td><td>${esc(v.by || '')}</td><td>${fmtAt(v.at)}</td><td><button class="small" data-inv="${esc(k)}">取り消す</button></td></tr>`).join('') : '<tr><td colspan="4" class="hint">なし</td></tr>');
}
$('inv-add').onclick = async () => {
  const m = $('inv-mail').value.trim();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(m)) return toast('メールの形になっていない');
  await db.ref('invites/' + mailKey(m)).set({ email: m, by: me(), at: now() }).catch(fail);
  $('inv-mail').value = ''; toast('招待した。本人が学校のアカウントでログインすれば使える');
};
$('v-tch').addEventListener('click', async e => {
  const b = e.target.closest('button'); if (!b) return;
  if (b.dataset.uid && confirm(`${S.teachers[b.dataset.uid].email} を外す？`)) await db.ref('teachers/' + b.dataset.uid).remove().catch(fail);
  if (b.dataset.inv) await db.ref('invites/' + b.dataset.inv).remove().catch(fail);
});

// ===== 設定 =====
function renderSet() {
  const st = S.settings;
  $('set-good').value = st.good; $('set-ok').value = st.ok; $('set-warn').value = st.warn; $('set-rule').value = st.rule; $('set-yutori').value = st.yutori; $('set-gas').value = st.gasUrl || '';
}
$('set-save').onclick = async () => {
  const v = { good: num($('set-good').value), ok: num($('set-ok').value), warn: num($('set-warn').value), rule: num($('set-rule').value), yutori: num($('set-yutori').value), gasUrl: $('set-gas').value.trim() };
  if ([v.good, v.ok, v.warn, v.rule, v.yutori].some(x => x == null) || !(v.good <= v.ok && v.ok <= v.warn && v.warn <= v.rule)) return alert('分数は ◎ ≦ ○ ≦ △ ≦ 規則の上限 の順に入れる');
  if (v.gasUrl && !/^https:\/\/script\.google\.com\/macros\/s\/[\w-]+\/exec$/.test(v.gasUrl)) return alert('GAS の URL は https://script.google.com/macros/s/…/exec の形');
  await db.ref('settings').set(v).catch(fail); toast('保存した');
};
