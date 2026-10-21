'use strict';
// 実習配置アプリ（2026-10-21 作り直し）
// 片道 = ①学生の駅まで（申告） + ②駅→駅（Maps） + ③施設の駅から（施設ごとに先生が決める）。住所は持たない。
// 最終は「住所から」＝家の住所→施設の住所を電車・バスで Maps に聞く（住所は入力欄の中だけ・保存するのは分数と経路だけ）

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
  year: null, view: 'fac', type: '評価', sel: null, sort: 'todo', calcStop: false, calcing: false, calcType: null, addr: {},
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
function busy(on, msg) {
  $('busy-msg').textContent = msg || '読み込み中…'; $('busy').classList.remove('prog'); $('busy').style.display = on ? 'flex' : 'none';
}
// 進み具合（題・済んだ数/全部・いま何をしているか）。止めるは S.calcStop を立てる＝今の分を保存してから止まる
function prog(title, done, total, sub, numText) {
  $('busy-msg').textContent = title; $('busy').classList.add('prog'); $('busy').style.display = 'flex';
  $('busy-bar').style.width = (total ? Math.min(100, done / total * 100) : 0) + '%';
  $('busy-num').textContent = numText || `${done} / ${total}`;
  $('busy-sub').textContent = S.calcStop ? '止めている…（今の分を保存してから止まる）' : (sub || '');
}
function fail(e) { console.error(e); alert('うまくいかなかった：' + (e && e.message || e)); }
// Firebase のキーに使えない文字を置き換える
const fk = s => String(s || '').trim().replace(/駅$/, '').replace(/[.#$/\[\]]/g, '_');
const mailKey = m => String(m || '').trim().toLowerCase().replace(/\./g, ',');
const stName = s => String(s || '').trim().replace(/駅$/, '');
// 学生の駅の種類（同じ「〇〇駅」でも JR の駅とバス停がある）。貼り付けの「〇〇（バス）」「〇〇バス停」「〇〇電停」も読む
function splitKind(s) {
  s = String(s || '').trim();
  let m = s.match(/^(.*?)\s*[（(](バス|路面電車|電車)[）)]$/); if (m) return { st: m[2] === '電車' ? stName(m[1]) : m[1].trim(), kind: m[2] };
  m = s.match(/^(.*?)\s*バス停$/); if (m) return { st: m[1].trim(), kind: 'バス' };
  m = s.match(/^(.*?)\s*電停$/); if (m) return { st: m[1].trim(), kind: '路面電車' };
  return { st: stName(s), kind: '電車' };
}
const isTrain = k => !k || k === '電車';
// バス停は「岡山駅」のように駅まで名前のことがある＝駅を削るのは電車だけ
const stClean = (st, kind) => isTrain(kind) ? stName(st) : String(st || '').trim();
const stLabel = (st, kind) => isTrain(kind) ? stName(st) : stClean(st, kind) + '（' + kind + '）';
// 地図で場所を探すときの言葉
const stQuery = (st, kind) => kind === 'バス' ? st + ' バス停' : kind === '路面電車' ? st + ' 電停' : st + '駅';
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
// バス停・電停は同じ名前の駅と別の経路として持つ
const bKey = b => isTrain(b.kind) ? b.st : b.st + '〔' + b.kind + '〕';
const doorOf = (sid, fid) => (((Y().door || {})[sid]) || {})[fid];
// 住所から：施設に着きたい時刻＝始業−ゆとり
function doorArrive(fid) {
  const [h, m] = startOf(fid).split(':').map(Number);
  const t = h * 60 + m - (num(S.settings.yutori) || 0);
  return String(Math.floor(t / 60)).padStart(2, '0') + ':' + String(t % 60).padStart(2, '0');
}

function bases(s) {
  const out = [];
  if (s.st && num(s.min) != null) out.push({ k: 'ふだん', st: s.st, kind: s.stKind || '電車', loc: s.stLoc || null, mode: s.mode || '徒歩', min: num(s.min) });
  if (s.jk && s.jk.ok && s.jk.st) out.push({ k: '実家', st: s.jk.st, kind: s.jk.kind || '電車', loc: s.jk.loc || null, mode: s.jk.mode || '徒歩', min: num(s.jk.min) || 0 });
  return out;
}

// 学生×施設の片道。いちばん短い通い方を返す
function evalPair(sid, fid) {
  const s = students()[sid] || {}, f = S.facilities[fid] || {};
  const opts = []; let pending = false, errs = [];
  const l3 = leg3(f), arr = arriveBy(fid), door = doorOf(sid, fid);
  // 住所からの分があれば、ふだんの駅の見積もりの代わりにそれを使う（最終）
  if (door && door.min != null) opts.push({ k: '住所から', total: door.min, d: door });
  else if (door && door.err) errs.push('住所から：' + door.err);
  for (const b of bases(s)) {
    if (b.k === 'ふだん' && door && door.min != null) continue;
    if (!f.station || l3 == null || !arr) { pending = true; continue; }
    const r = S.routes[rKey(bKey(b), f.station, arr)];
    if (!r) { pending = true; continue; }
    if (r.err) { errs.push(b.k + '：' + r.err); continue; }
    opts.push({ k: b.k, total: b.min + r.ride + l3, b, r, l3 });
  }
  const car = (((Y().car || {})[sid]) || {})[fid];
  if (s.carDirect && f.carOk && car != null) opts.push({ k: '車', total: +car });
  opts.sort((a, b) => a.total - b.total);
  const best = opts[0] || null;
  let prop = null;   // 駅に自転車を置けば
  if (best && best.k !== '車' && best.k !== '住所から' && (f.access || '徒歩') === '徒歩' && num(f.bike) != null && num(f.bike) < num(f.walk) && best.total > num(S.settings.ok)) {
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
  const nAll = fids.length, nDraft = fids.filter(fid => S.facilities[fid].station && S.facilities[fid].draft).length,
    nFix = fids.filter(fid => S.facilities[fid].station && !S.facilities[fid].draft).length, nNone = nAll - nDraft - nFix;
  $('fac-sum').innerHTML = !nAll ? '' : `<div class="meter"><i class="g" style="width:${nFix / nAll * 100}%"></i><i class="y" style="width:${nDraft / nAll * 100}%"></i></div>
    <span class="tag grn">駅が決まった ${nFix}</span><span class="tag yel">下書きのまま ${nDraft}</span><span class="tag red">駅なし ${nNone}</span><span class="hint" style="margin:0 0 0 6px">／${nAll}施設</span>`;
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

$('busy-stop').onclick = () => { S.calcStop = true; $('busy-sub').textContent = '止めている…（今の分を保存してから止まる）'; };

// 駅の下書き（駅が空で住所がある施設）
$('fac-draft').onclick = async () => {
  // 駅が空の施設と、まだ「駅は下書き」のままの施設（先生が直した駅は触らない）
  const todo = Object.keys(S.facilities).filter(fid => (!S.facilities[fid].station || S.facilities[fid].draft) && S.facilities[fid].address);
  if (!todo.length) return toast('駅が空・下書きのままの施設は無い');
  if (!confirm(`${todo.length}施設の最寄り（施設から歩いて一番近い駅・バス停・電停）を下書きする（駅が空の施設と「駅は下書き」のままの施設。先生が直した駅は触らない）`)) return;
  let ok = 0; const errs = {}; const okayama = []; S.calcStop = false;
  const nm = fid => S.facilities[fid].name || fid;
  const show = (i, sub) => prog('駅の下書き', i, todo.length, `できた ${ok}・できなかった ${i - ok}　${sub}`, `${i} / ${todo.length}施設`);
  try {
    for (let i = 0; i < todo.length && !S.calcStop; i += 5) {   // 1件で地図に10回あまり聞く＝GASの6分に収まるよう5件ずつ
      const part = todo.slice(i, i + 5);
      show(i, `いま：${part.map(nm).join('、')}の場所を調べている`);
      const geos = await gas('geo', part.map(fid => ({ address: S.facilities[fid].address })));
      const jobs = [];
      for (let k = 0; k < part.length; k++) {
        show(i, `いま：${nm(part[k])}の近くの駅・バス停を探している`);
        const here = geos[k] && geos[k].lat != null ? geos[k] : null;
        const cands = here ? await osmStops(here) : [];
        jobs.push({ address: S.facilities[part[k]].address, arrive: startOf(part[k]), here, cands });
      }
      show(i, `いま：${part.map(nm).join('、')}の駅までの道を調べている`);
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
      show(Math.min(i + 5, todo.length), '');
    }
    const ng = Object.keys(errs), stopped = S.calcStop ? `止めた（残り ${todo.length - ok - Object.values(errs).flat().length}件は、もう一度押せば続きから）\n` : '';
    const oka = okayama.length ? `\n\n岡山駅から歩きの経路しか出なかった ${okayama.length}件（駅は「岡山」で入れた・確かめる）：${okayama.join('、')}` : '';
    if (ng.length || oka || stopped) {
      busy(false);
      alert(stopped + `下書きできた ${ok}件／できなかった ${todo.length - ok}件` + oka + (ng.length ? '\n\n' : '') + ng.map(m => `【${m}】${errs[m].length}件：${errs[m].slice(0, 5).join('、')}${errs[m].length > 5 ? ' ほか' : ''}`).join('\n'));
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
      <td>${s.st ? esc(stLabel(s.st, s.stKind)) : '<span class="tag red">未</span>'}${Object.keys((Y().door || {})[sid] || {}).length ? ' <span class="tag">住所から済</span>' : ''}</td><td>${s.min != null ? esc(s.mode || '') + s.min + '分' : ''}</td>
      <td>${s.carDirect ? '可' : ''}</td><td>${jk.ok ? '可：' + esc(stLabel(jk.st || '?', jk.kind)) + (jk.min != null ? '（' + esc(jk.mode || '') + jk.min + '分）' : '') : ''}</td>
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
  fm.st.value = stClean(s.st, s.stKind); fm.stKind.value = s.stKind || '電車';
  $('stu-st-where').textContent = s.stAddr && !isTrain(s.stKind) ? '地図で読んだ場所：' + s.stAddr : '';
  $('stu-jk-where').textContent = jk.addr && !isTrain(jk.kind) ? '地図で読んだ場所：' + jk.addr : '';
  fm.mode.value = s.mode || '徒歩';
  TYPES.forEach(t => fm['t' + t].checked = !!(s.t || {})[t]);
  fm.ped.checked = !!s.ped; fm.carDirect.checked = !!s.carDirect;
  fm.jkOk.value = jk.ok ? '1' : ''; fm.jkSt.value = stClean(jk.st, jk.kind); fm.jkKind.value = jk.kind || '電車'; fm.jkMode.value = jk.mode || '徒歩'; fm.jkMin.value = jk.min == null ? '' : jk.min;
  $('stu-del').style.display = sid ? '' : 'none';
  $('stu-del').onclick = async () => {
    if (!confirm(`${s.name}を${S.year}年度から消す？（この年度の配置と車の分数も消える）`)) return;
    const up = { [ypath('students/' + sid)]: null, [ypath('car/' + sid)]: null, [ypath('door/' + sid)]: null };
    TYPES.forEach(t => up[ypath(`assignments/${t}/${sid}`)] = null);
    await db.ref().update(up).catch(fail); $('dlg-stu').close();
  };
  $('dlg-stu').onclose = async () => {
    if ($('dlg-stu').returnValue !== 'ok') return;
    const id = fk(fm.sid.value);
    if (!id) return;
    if (!sid && students()[id] && !confirm(`${id} はもういる。上書きする？`)) return;
    const t = {}; TYPES.forEach(x => t[x] = fm['t' + x].checked);
    const stKind = fm.stKind.value, jkind = fm.jkKind.value, st = stClean(fm.st.value, stKind), jst = stClean(fm.jkSt.value, jkind);
    const old = students()[id] || {}, oj = old.jk || {};
    // 名前と種類が前と同じなら、地図で読んだ場所はそのまま
    const same1 = stClean(old.st, old.stKind) === st && (old.stKind || '電車') === stKind, same2 = stClean(oj.st, oj.kind) === jst && (oj.kind || '電車') === jkind;
    const rec = {
      name: fm.name.value.trim(), grade: fm.grade.value.trim(), t, ped: fm.ped.checked,
      st, stKind, stLoc: same1 ? (old.stLoc || null) : null, stAddr: same1 ? (old.stAddr || null) : null,
      mode: fm.mode.value, min: num(fm.min.value), carDirect: fm.carDirect.checked,
      jk: { ok: fm.jkOk.value === '1', st: jst, kind: jkind, mode: fm.jkMode.value, min: num(fm.jkMin.value),
        loc: same2 ? (oj.loc || null) : null, addr: same2 ? (oj.addr || null) : null },
      slip: fm.slip.value.trim(), past: fm.past.value.trim(),
    };
    await db.ref(ypath('students/' + id)).set(rec).catch(fail);
    await locateStops([id]).catch(fail);
    const s2 = students()[id] || rec, j2 = s2.jk || {};
    const w = [!isTrain(stKind) && s2.stAddr ? stLabel(st, stKind) + '＝' + s2.stAddr : '', !isTrain(jkind) && j2.addr ? stLabel(jst, jkind) + '＝' + j2.addr : ''].filter(Boolean);
    toast(w.length ? '保存した。地図で読んだ場所：' + w.join('／') : '保存した');
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
    if (g(7)) { const k = splitKind(g(7)); if (k.st !== stClean(s.st, s.stKind) || k.kind !== (s.stKind || '電車')) { s.stLoc = null; s.stAddr = null; } s.st = k.st; s.stKind = k.kind; }
    if (g(8)) s.mode = MODES.includes(g(8)) ? g(8) : '徒歩';
    if (g(9)) s.min = num(g(9));
    if (g(10)) s.carDirect = yes(g(10));
    s.jk = { ...(s.jk || {}) };
    if (g(11)) s.jk.ok = yes(g(11));
    if (g(12)) { const k = splitKind(g(12)); if (k.st !== stClean(s.jk.st, s.jk.kind) || k.kind !== (s.jk.kind || '電車')) { s.jk.loc = null; s.jk.addr = null; } s.jk.st = k.st; s.jk.kind = k.kind; }
    if (g(13)) s.jk.mode = MODES.includes(g(13)) ? g(13) : '徒歩';
    if (g(14)) s.jk.min = num(g(14));
    if (g(15)) s.slip = g(15);
    if (g(16)) s.past = g(16);
    up[ypath('students/' + id)] = s; n++;
  }
  await db.ref().update(up); toast(n + '人を取り込んだ');
  const m = await locateStops(Object.keys(up).map(p => p.split('/').pop()));
  if (m) toast(n + '人を取り込んだ。バス停・電停 ' + m + '件の場所を地図で読んだ（学生の画面で確かめられる）');
});
// バス停・電停は名前だけだと別の所に当たる＝地図で場所を読んで持つ（駅は名前のままでよい）
async function locateStops(sids) {
  const todo = [];
  for (const sid of sids) {
    const s = students()[sid]; if (!s) continue;
    if (s.st && !isTrain(s.stKind) && !s.stLoc) todo.push({ sid, jk: false, st: s.st, kind: s.stKind });
    if (s.jk && s.jk.st && !isTrain(s.jk.kind) && !s.jk.loc) todo.push({ sid, jk: true, st: s.jk.st, kind: s.jk.kind });
  }
  if (!todo.length || !S.settings.gasUrl) return 0;
  const up = {}; let n = 0;
  for (let i = 0; i < todo.length; i += 10) {
    const part = todo.slice(i, i + 10);
    const res = await gas('geo', part.map(x => ({ address: stQuery(x.st, x.kind) })));
    part.forEach((x, k) => {
      const r = res[k] || {}; if (r.lat == null) return;
      const base = ypath(`students/${x.sid}/`);
      up[base + (x.jk ? 'jk/loc' : 'stLoc')] = r.lat + ',' + r.lng; up[base + (x.jk ? 'jk/addr' : 'stAddr')] = r.addr || ''; n++;
    });
  }
  if (n) await db.ref().update(up);
  return n;
}
$('stu-tpl').onclick = () => {
  const ex = ['S0001', '学生A', '3年', '○', '', '', '', '倉敷駅前（バス）', '自転車', '10', '', '可', '新見', '車', '15', '2026-11-05', ''];
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
    const raw = $('paste-text').value;
    const rows = raw.split(/\r?\n/).filter(l => l.trim()).map(l => l.split(l.includes('\t') ? '\t' : ',').map(c => c.trim()));
    try { await onOk(rows, raw); } catch (e) { fail(e); }
  };
  d.showModal();
}

// ===== 3. 計算 =====
// 計算は1本：施設の駅からの徒歩 → 駅→駅（ふだん・実家） → 住所から（住所を読み込んだ学生だけ） → 車（車で直接の学生）
// 範囲＝全部／学生／施設／1件。やり方＝todo（まだの分だけ）／ng（経路なしだけやり直す）／all（上書きで全部やり直す）
// 住所は S.addr の中だけ（画面を離れると消える・保存しない）。保存するのは分数と経路だけ
const doorFacs = sid => Object.keys(S.facilities).filter(fid => S.facilities[fid].address && TYPES.some(t => ((students()[sid] || {}).t || {})[t] && num(((yFac(fid).cap) || {})[t]) > 0));
const carFacs = sid => doorFacs(sid).filter(fid => S.facilities[fid].carOk);
const addrOf = sid => (S.addr || {})[sid] || '';
// 学生×施設の組（その学生の実習の種別で動いている施設）。scope で絞る
function pairsOf(scope) {
  scope = scope || {}; const P = new Map();
  for (const t of TYPES) for (const sid of studsOf(t)) {
    if (scope.sid && scope.sid !== sid) continue;
    for (const fid of facsOf(t)) {
      if (scope.fid && scope.fid !== fid) continue;
      if (!P.has(sid)) P.set(sid, new Set());
      P.get(sid).add(fid);
    }
  }
  return P;
}
// 1件の状態：done（出た）／ng（経路なし）／todo（まだ）。住所を読み込んだ学生は住所からの分が出るまで todo
function cellState(sid, fid) {
  const D = doorOf(sid, fid), ev = evalPair(sid, fid);
  if (D && D.min != null) return { st: 'done', ev, src: '住' };
  if (addrOf(sid) && !(D && D.err)) return { st: 'todo', ev };
  if (ev.best) return { st: 'done', ev, src: ev.best.k === '車' ? '車' : '' };
  if (ev.errs.length && !ev.pending) return { st: 'ng', ev };
  return { st: 'todo', ev };
}
const want = (mode, has, err) => mode === 'all' || (mode === 'todo' && !has) || (mode === 'ng' && !!err);
// 駅→駅で聞く分（同じ駅の組は1回）
function transitJobs(P, mode) {
  const out = {};
  P.forEach((fids, sid) => {
    const bs = bases(students()[sid] || {});
    for (const fid of fids) {
      const f = S.facilities[fid], arr = arriveBy(fid);
      if (!f.station || !arr) continue;
      for (const b of bs) {
        if (b.k === 'ふだん' && ((doorOf(sid, fid) || {}).min != null || addrOf(sid))) continue;   // 住所から出す（出した）
        const key = rKey(bKey(b), f.station, arr), r = S.routes[key];
        if (want(mode, !!r, r && r.err)) out[key] = { from: stName(b.st), fromLoc: isTrain(b.kind) ? null : (b.loc || null), fromKind: b.kind, to: stName(f.station), toLoc: f.stopLoc || null, arrive: arr };
      }
    }
  });
  return out;
}
// 計算の本体
async function runCalc(scope, mode, label) {
  scope = scope || {};
  if (S.calcing) return toast('いま計算中');
  if (!S.settings.gasUrl) return alert('設定で経路計算（GAS）の URL を入れる');
  const P = pairsOf(scope); if (!P.size) return toast('計算する組が無い');
  S.calcing = true; S.calcStop = false;
  let done = 0, total = 0, stage = '準備', nSaved = 0;
  const show = () => prog(label, done, total, stage, `${done} / ${total}件`);
  const step = n => { done += n; nSaved += n; show(); renderCalc(); };
  const fset = new Set(); P.forEach(fs => fs.forEach(fid => fset.add(fid)));
  // 住所からと車（住所を読み込んだ学生だけ）
  const doorJ = [], carJ = []; let noAddr = 0;
  P.forEach((fids, sid) => {
    const from = addrOf(sid), D = (Y().door || {})[sid] || {}, C = (Y().car || {})[sid] || {};
    if (!from) { if ([...fids].some(fid => D[fid] && (mode === 'all' || (mode === 'ng' && D[fid].err)))) noAddr++; return; }
    const fs = doorFacs(sid).filter(fid => fids.has(fid) && want(mode, D[fid] && (D[fid].min != null || D[fid].err), D[fid] && D[fid].err));
    if (fs.length) doorJ.push({ sid, from, fs });
    if (students()[sid].carDirect && mode !== 'ng') {
      const cs = carFacs(sid).filter(fid => fids.has(fid) && want(mode, C[fid] != null, false));
      if (cs.length) carJ.push({ sid, from, cs });
    }
  });
  const nDoor = doorJ.reduce((a, x) => a + x.fs.length, 0), nCar = carJ.reduce((a, x) => a + x.cs.length, 0);
  try {
    stage = 'バス停・電停の場所を調べている'; show();
    await locateStops([...P.keys()]);
    // ① 施設の駅から徒歩
    const walk = [...fset].filter(fid => { const f = S.facilities[fid]; return f.station && f.address && (f.access || '徒歩') === '徒歩' && (f.walk == null || (mode === 'all' && !scope.sid)); });   // 学生を指定したときは施設の徒歩は測り直さない（ほかの学生の経路が変わる）
    total = walk.length + Object.keys(transitJobs(P, mode)).length + nDoor + nCar;
    for (let i = 0; i < walk.length && !S.calcStop; i += 10) {
      const part = walk.slice(i, i + 10);
      stage = `施設の駅から歩く時間：${S.facilities[part[0]].name}${part.length > 1 ? ' ほか' + (part.length - 1) + '件' : ''}`; show();
      const res = await gas('walk', part.map(fid => ({ station: S.facilities[fid].station, loc: S.facilities[fid].stopLoc || null, address: S.facilities[fid].address })));
      const up = {};
      part.forEach((fid, k) => { const r = res[k] || {}; if (r.walk != null) { up[`facilities/${fid}/walk`] = r.walk; up[`facilities/${fid}/bike`] = r.bike; up[`facilities/${fid}/walkPoly`] = r.poly || null; Object.assign(S.facilities[fid], { walk: r.walk, bike: r.bike, walkPoly: r.poly || null }); } });
      await db.ref().update(up); step(part.length);
    }
    // ② 駅→駅（徒歩が出て着きたい時刻が決まったので、ここで出し直す）
    const tj = transitJobs(P, mode), keys = Object.keys(tj);
    total = done + keys.length + nDoor + nCar;
    for (let i = 0; i < keys.length && !S.calcStop; i += 10) {
      const part = keys.slice(i, i + 10);
      stage = `駅→駅の電車・バス：${tj[part[0]].from} → ${tj[part[0]].to}${part.length > 1 ? ' ほか' + (part.length - 1) + '件' : ''}`; show();
      const res = await gas('transit', part.map(k => tj[k]));
      const up = {};
      part.forEach((k, n) => { const r = res[n] || { err: '応答なし' }; up['routes/' + k] = S.routes[k] = { ...r, from: tj[k].from, to: tj[k].to, arrive: tj[k].arrive, at: now() }; });
      await db.ref().update(up); step(part.length);
    }
    // ③ 住所から
    for (const j of doorJ) {
      const nm = students()[j.sid].name;
      for (let i = 0; i < j.fs.length && !S.calcStop; i += 10) {
        const part = j.fs.slice(i, i + 10), up = {};
        stage = `住所から：${nm}（施設 ${i + 1}〜${i + part.length} / ${j.fs.length}）`; show();
        const res = await gas('door', part.map(fid => ({ from: j.from, to: S.facilities[fid].address, arrive: doorArrive(fid) })));
        part.forEach((fid, k) => { const r = res[k] || { err: '応答なし' }; up[ypath(`door/${j.sid}/${fid}`)] = { ...r, arrive: doorArrive(fid), at: now() }; });
        await db.ref().update(up); step(part.length);
      }
    }
    // ④ 車で直接
    for (const j of carJ) {
      const nm = students()[j.sid].name;
      for (let i = 0; i < j.cs.length && !S.calcStop; i += 10) {
        const part = j.cs.slice(i, i + 10), up = {};
        stage = `車：${nm}（施設 ${i + 1}〜${i + part.length} / ${j.cs.length}）`; show();
        const res = await gas('car', part.map(fid => ({ from: j.from, to: S.facilities[fid].address, arrive: startOf(fid) })));
        part.forEach((fid, k) => { if (res[k] && res[k].car != null) up[ypath(`car/${j.sid}/${fid}`)] = res[k].car; });
        await db.ref().update(up); step(part.length);
      }
    }
  } catch (e) { fail(e); }
  const stopped = S.calcStop;
  S.calcing = false; S.calcStop = false; busy(false); renderCalc();
  const notes = [];
  if (noAddr) notes.push(`住所を読み込んでいない学生 ${noAddr}人は、住所からの分を前のまま残した（やり直すなら住所を読み込んでから）`);
  const msg = (stopped ? `止めた（${done} / ${total}件まで保存した。「まだの分を計算」で続きから）` : total ? `終わった（${nSaved}件）` : 'やる分が無かった') + (notes.length ? '\n\n' + notes.join('\n') : '');
  if (notes.length || stopped) alert(msg); else toast(msg);
}
const MODE_LABEL = { todo: 'まだの分を計算', ng: '経路なしだけやり直す', all: '上書きで全部やり直す' };
function askRun(scope, mode, what) {
  if (mode === 'all' && !confirm(`${what}を上書きで全部やり直す？（もう出ている分も Google Maps に聞き直す）`)) return;
  runCalc(scope, mode, `${what}：${MODE_LABEL[mode]}`);
}

// 画面：上に道具と全体の進み具合、下に学生×施設の表（種別ごと）
function renderCalc() {
  const P = pairsOf(), n = { done: 0, ng: 0, todo: 0, door: 0 };
  P.forEach((fs, sid) => fs.forEach(fid => { const c = cellState(sid, fid); n[c.st]++; if (c.src === '住') n.door++; }));
  const all = n.done + n.ng + n.todo, sids = [...P.keys()];
  const nAddr = sids.filter(addrOf).length;
  const walkTodo = Object.keys(S.facilities).filter(fid => { const f = S.facilities[fid]; return f.station && f.address && (f.access || '徒歩') === '徒歩' && f.walk == null; }).length;
  const noBase = sids.filter(sid => !bases(students()[sid]).length && !addrOf(sid) && !Object.keys(((Y().door || {})[sid]) || {}).length).length;
  const noSt = [...new Set([].concat(...[...P.values()].map(s => [...s])))].filter(fid => !S.facilities[fid].station || !arriveBy(fid)).length;
  $('calc-sum').innerHTML = `<div class="row" style="gap:6px"><b>出た ${n.done} / ${all}件</b>
    <span class="tag grn">出た ${n.done}（うち住所から ${n.door}）</span><span class="tag red">経路なし ${n.ng}</span><span class="tag">まだ ${n.todo}</span>
    ${walkTodo ? `<span class="tag">施設の駅からの徒歩 まだ ${walkTodo}</span>` : ''}
    ${noBase ? `<span class="tag red">駅か分数が空の学生 ${noBase}人</span>` : ''}${noSt ? `<span class="tag red">駅か駅からの時間が空の施設 ${noSt}</span>` : ''}
    ${S.settings.gasUrl ? '' : '<span class="tag red">設定で GAS の URL を入れる</span>'}</div>
    <div class="meter"><i class="g" style="width:${all ? n.done / all * 100 : 0}%"></i><i class="r" style="width:${all ? n.ng / all * 100 : 0}%"></i></div>
    <div class="hint" style="margin:0">住所を読み込んだ学生 <b>${nAddr} / ${sids.length}人</b>（画面を離れると消える）${nAddr ? ' <button class="small" id="addr-clear">住所を消す</button>' : ''}</div>`;
  // 表（種別ごと）
  const t = TYPES.includes(S.calcType) ? S.calcType : TYPES.find(t => studsOf(t).length) || TYPES[0];
  $('calc-tabs').innerHTML = TYPES.map(x => `<button data-t="${x}" class="${x === t ? 'on' : ''}">${x}（学生${studsOf(x).length}・施設${facsOf(x).length}）</button>`).join('');
  const ss = studsOf(t).sort(), fs = facsOf(t);
  if (!ss.length || !fs.length) { $('calc-grid').innerHTML = `<tr><td class="hint">${t}の学生か施設がいない。</td></tr>`; return; }
  const cells = ss.map(sid => fs.map(fid => cellState(sid, fid)));
  $('calc-grid').innerHTML = `<thead><tr><th class="cg-nm">学生 ＼ 施設</th>${fs.map(fid => {
    const k = cells.filter(r => r[fs.indexOf(fid)].st === 'done').length;
    return `<th class="cg-f" data-fid="${esc(fid)}" title="${esc(S.facilities[fid].name)}：押すとこの施設をやり直す"><span>${esc(S.facilities[fid].name)}</span><small>${k}/${ss.length}</small></th>`;
  }).join('')}</tr></thead><tbody>${ss.map((sid, r) => {
    const s = students()[sid], row = cells[r], k = row.filter(c => c.st === 'done').length;
    return `<tr><th class="cg-nm" data-sid="${esc(sid)}" title="押すとこの学生をやり直す・住所を入れる">${esc(s.name)}${addrOf(sid) ? ' <span class="tag blu">住所</span>' : ''}<small>${k}/${fs.length}</small></th>${row.map((c, i) => {
      const tot = c.ev.best ? c.ev.best.total : null, m = mark(tot);
      const txt = c.st === 'done' ? `<b class="${m.c}">${m.m}</b>${tot}${c.src ? `<i>${c.src}</i>` : ''}` : c.st === 'ng' ? '経路なし' : (c.ev.best ? `<span class="old">${tot}</span>` : '·');
      return `<td class="cg c-${c.st}" data-sid="${esc(sid)}" data-fid="${esc(fs[i])}">${txt}</td>`;
    }).join('')}</tr>`;
  }).join('')}</tbody>`;
}
$('calc-tabs').onclick = e => { const b = e.target.closest('button[data-t]'); if (b) { S.calcType = b.dataset.t; renderCalc(); } };
$('calc-todo').onclick = () => askRun({}, 'todo', '全部');
$('calc-ng').onclick = () => askRun({}, 'ng', '全部');
$('calc-all').onclick = () => askRun({}, 'all', '全部');
$('calc-sum').onclick = e => { if (e.target.id === 'addr-clear' && confirm('読み込んだ住所を消す？（出た分数は残る）')) { S.addr = {}; renderCalc(); } };
// 表を押す：見出し＝施設、左＝学生、セル＝その1件
$('calc-grid').onclick = e => {
  const c = e.target.closest('[data-sid],[data-fid]'); if (!c) return;
  const sid = c.dataset.sid || null, fid = c.dataset.fid || null;
  const what = sid && fid ? `${students()[sid].name} × ${S.facilities[fid].name}` : sid ? students()[sid].name : S.facilities[fid].name;
  openScope({ sid, fid }, what);
};
function openScope(scope, what) {
  const d = $('dlg-scope'), P = pairsOf(scope); let n = { done: 0, ng: 0, todo: 0 };
  P.forEach((fs, sid) => fs.forEach(fid => n[cellState(sid, fid).st]++));
  $('scope-title').textContent = what;
  let info = `出た ${n.done}・経路なし ${n.ng}・まだ ${n.todo}`;
  if (scope.sid && scope.fid) {
    const ev = evalPair(scope.sid, scope.fid);
    info += '<br>' + ev.opts.map(o => `${esc(o.k)}：${o.total}分`).concat(ev.errs.map(esc)).join('<br>');
    if (ev.opts.length) info += '<br><button type="button" class="small" id="scope-detail">経路を地図で見る</button>';
  }
  $('scope-info').innerHTML = info;
  const one = !!scope.sid && !scope.fid;
  $('scope-addr-row').style.display = scope.sid ? '' : 'none';
  $('scope-addr').value = scope.sid ? addrOf(scope.sid) : '';
  d.returnValue = '';
  d.onclose = () => {
    const m = d.returnValue; if (!MODE_LABEL[m]) return;
    if (scope.sid) { const a = $('scope-addr').value.trim(); S.addr = S.addr || {}; if (a) S.addr[scope.sid] = a; else delete S.addr[scope.sid]; }
    $('scope-addr').value = '';
    askRun(scope, m, what);
  };
  d.showModal();
  if (one) $('scope-addr').focus();
  const sd = $('scope-detail'); if (sd) sd.onclick = () => { d.close(''); openDetail(scope.sid, scope.fid); };
}
async function gas(action, jobs) {
  if (!S.settings.gasUrl) throw new Error('設定で経路計算（GAS）の URL を入れる');
  const idToken = await auth.currentUser.getIdToken();
  const r = await fetch(S.settings.gasUrl, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: JSON.stringify({ action, jobs, idToken }) });
  const j = await r.json();
  if (j.status !== 'OK') throw new Error(j.message || 'GAS のエラー');
  return j.results;
}
// Excel から貼った表を読む（タブ区切り・セルの中の改行は "…" で囲まれて来る）。タブが無ければカンマ
function readSheet(raw) {
  raw = String(raw || '').replace(/\r\n?/g, '\n');
  const sep = raw.includes('\t') ? '\t' : ',', rows = [];
  let row = [], cell = '', q = false;
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i];
    if (q) { if (c === '"' && raw[i + 1] === '"') { cell += '"'; i++; } else if (c === '"') q = false; else cell += c; }
    else if (c === '"' && !cell) q = true;
    else if (c === sep) { row.push(cell); cell = ''; }
    else if (c === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; }
    else cell += c;
  }
  row.push(cell); rows.push(row);
  return rows.map(r => r.map(x => x.replace(/\s+/g, ' ').trim())).filter(r => r.some(x => x));
}
const nz = s => String(s || '').normalize('NFKC').replace(/\s+/g, '');
const ADDR_RE = /[都道府県市区町村郡]|丁目|番地|[0-9]+-[0-9]+/;
// 1行＝1人。学籍番号か名前の列で学生を決め、住所の列（いくつに分かれていてもつなぐ）で計算する
// 学籍番号も名前も無い（住所だけの列）なら、学生一覧の順（学籍番号順）に1行ずつ当てる＝先に確かめる
function readAddrRows(raw) {
  const all = students(), sidOf = {}, byName = {};
  Object.keys(all).forEach(sid => {
    sidOf[nz(sid)] = sid;
    const n = nz(all[sid].name); if (n) byName[n] = byName[n] === undefined ? sid : null;   // 同じ名前が2人なら名前では決めない
  });
  const who = c => sidOf[nz(c)] || sidOf[nz(fk(c))] || byName[nz(c)] || null;
  let rows = readSheet(raw), cols = null;
  // 見出し行があれば列を見出しで決める
  const hi = rows.findIndex(r => r.some(c => /住所|所在地|都道府県|市区町村|番地/.test(c)) && !r.some(who) && !r.some(c => ADDR_RE.test(c) && /\d/.test(c)));
  if (hi === 0) {
    const h = rows[0];
    cols = { id: h.findIndex(c => /学籍|番号|ID/i.test(c)), name: h.findIndex(c => /氏名|名前/.test(c) && !/ふりがな|フリガナ|カナ/.test(c)),
      addr: h.map((c, k) => /住所|所在地|都道府県|市区町村|町名|番地|建物|方書/.test(c) && !/メール|mail/i.test(c) ? k : -1).filter(k => k >= 0) };
    rows = rows.slice(1);
  }
  const out = [], miss = [];
  for (const r of rows) {
    let sid = null, addr = '';
    if (cols) {
      sid = (cols.id >= 0 && who(r[cols.id])) || (cols.name >= 0 && who(r[cols.name])) || r.map(who).find(x => x) || null;
      addr = cols.addr.map(k => r[k] || '').join(' ').trim();
    } else {
      const k = r.findIndex(who); sid = k >= 0 ? who(r[k]) : null;
      // 住所らしいセルから右へ、メール・電話・郵便番号でないセルをつなぐ（「岡山市北区…」「1-2-3」「○○マンション101」と分かれていても読む）
      const rest = r.map((c, x) => ({ c, x })).filter(o => o.x !== k && o.c && !/@/.test(o.c) && !/^〒?\s*\d{3}-?\d{4}$/.test(o.c) && !/^[\d\-()（） ]{10,}$/.test(o.c) && !(sid && nz(o.c) === nz(all[sid].name)));
      const a0 = rest.findIndex(o => ADDR_RE.test(o.c));
      addr = (a0 >= 0 ? rest.slice(a0) : rest).map(o => o.c).join(' ').trim();
    }
    if (!addr) continue;
    if (sid) out.push({ sid, from: addr }); else miss.push({ row: r.join(' '), from: addr });
  }
  return { out, miss };
}
$('addr-paste').onclick = () => openPaste('住所を読み込む（保存しない）', 'Excel の表をそのまま貼る（1行＝1人・見出し行があってもよい）。学籍番号か名前の列で学生を決める。住所が「市区町村」「番地」「建物」に分かれていてもつなぐ。住所だけの列なら学籍番号の順に当てる（先に確かめる）。住所はこの画面の中だけに持ち、保存しない（画面を離れると消える）。読み込んだら「まだの分を計算」で住所からの分を出す。', async (rows, raw) => {
  let { out: list, miss } = readAddrRows(raw);
  if (!list.length && miss.length) {
    // 住所だけ：学籍番号の順に当てる
    const sids = Object.keys(students()).sort();
    const n = Math.min(sids.length, miss.length);
    const pairs = miss.slice(0, n).map((m, i) => ({ sid: sids[i], from: m.from }));
    const show = pairs.map(p => `${p.sid} ${students()[p.sid].name || ''} ← ${p.from}`).join('\n');
    if (!confirm(`学籍番号・名前の列が無いので、学籍番号の順に当てる。合っている？\n（住所 ${miss.length}行・学生 ${sids.length}人${miss.length !== sids.length ? '＝数が合っていない' : ''}）\n\n` + show)) return;
    list = pairs; miss = [];
  }
  if (!list.length) return toast('住所が読めない');
  S.addr = S.addr || {}; list.forEach(x => S.addr[x.sid] = x.from);
  renderCalc();
  const go = confirm(`${list.length}人の住所を読み込んだ（保存していない）。` + (miss.length ? `\n\n学生が決まらなかった行（学籍番号・名前が合わない）：\n${miss.map(m => m.row.slice(0, 40)).join('\n')}\n` : '') + '\n\nこのまま「まだの分を計算」する？');
  if (go) askRun({}, 'todo', '全部');
});

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
    h += `<div class="box"><b><span class="mk ${mk.c}">${mk.m}</span> ${o.k === '車' ? '車で直接' : o.k === '住所から' ? '家の住所から（電車・バス）' : o.k + 'の駅から'}：${fmtMin(o.total)}</b>`;
    if (o.k === '住所から') {
      const d = o.d;
      h += `<table class="dt" style="margin-top:6px">
        <tr><td>出る→着く</td><td>${esc(d.dep || '?')}発 → ${esc(d.arr || '?')}着（${esc(d.arrive || '')}までに着く便・乗換${d.transfers ?? 0}回${d.shinkansen ? '・新幹線' : ''}）</td></tr>
        <tr><td>乗る物</td><td>${d.lines ? esc(d.lines) : '歩きだけ'}</td></tr>
        <tr><td>歩き</td><td>家から乗る所まで ${d.walk1 ?? 0}分・降りてから施設まで ${d.walk2 ?? 0}分（Maps の見積もり）</td></tr></table>`;
    } else if (o.k !== '車') {
      h += `<table class="dt" style="margin-top:6px">
        <tr><td>① 駅まで</td><td>${esc(stLabel(o.b.st, o.b.kind))}${isTrain(o.b.kind) ? '駅' : ''}まで ${esc(o.b.mode)} ${o.b.min}分（本人の申告）</td></tr>
        <tr><td>② 電車・バス</td><td>${o.r.ride}分（${esc(o.r.dep)}発→${esc(o.r.arr)}着・乗換${o.r.transfers}回${o.r.shinkansen ? '・新幹線' : ''}）<div class="hint" style="margin:2px 0 0">${esc(o.r.lines)}</div>
          ${o.r.fromAddr ? `<div class="hint" style="margin:0">Maps が読んだ駅：${esc(o.r.fromAddr)} → ${esc(o.r.toAddr)}</div>` : ''}</td></tr>
        <tr><td>③ 施設の駅から</td><td>${esc(stName(f.station))}${f.stopKind && f.stopKind !== '電車' ? '（' + esc(f.stopKind) + '）' : '駅'}から ${esc(f.access || '徒歩')} ${o.l3}分</td></tr></table>`;
    } else h += `<div class="hint">本人の住所から車（住所は保存していない）</div>`;
    if (o.k !== '車') h += `<div class="rmap" data-i="${ev.opts.indexOf(o)}"></div>`;
    h += `</div>`;
  }
  if (ev.prop != null) h += `<p class="prop" style="color:var(--ok)">駅に自転車を置けば 約${ev.prop}分（③を自転車${f.bike}分にした目安）</p>`;
  $('detail-body').innerHTML = h; $('dlg-detail').showModal();
  document.querySelectorAll('#detail-body .rmap').forEach(el => drawRoute(el, ev.opts[+el.dataset.i], f));
}
// Google の折れ線（encoded polyline）を緯度経度の並びに戻す
function unpoly(str) {
  const pts = []; let i = 0, lat = 0, lng = 0;
  while (i < str.length) {
    for (const k of [0, 1]) {
      let b, sh = 0, r = 0;
      do { b = str.charCodeAt(i++) - 63; r |= (b & 31) << sh; sh += 5; } while (b >= 32);
      const d = r & 1 ? ~(r >> 1) : r >> 1;
      if (k) lng += d; else lat += d;
    }
    pts.push([lat / 1e5, lng / 1e5]);
  }
  return pts;
}
// 大まかな経路を地図に描く：電車・バスは色の実線、歩きは点線。乗る所・降りる所に名前（家から乗る所までの線は持っていない）
function drawRoute(el, o, f) {
  const segs = o.k === '住所から' ? (o.d.poly || []) : (o.r.poly || []).concat(o.r.poly && f.walkPoly && (f.access || '徒歩') === '徒歩' ? [{ m: 'W', p: f.walkPoly }] : []);
  if (!segs.length || !window.L) { el.outerHTML = `<div class="hint" style="margin:6px 0 0">${window.L ? '地図の線が無い（地図の機能より前に計算した）。3. 計算の表でこのマスを押して「上書き」でやり直すと出る。' : '地図を読み込めなかった（ネットにつながっているか）。'}</div>`; return; }
  const map = L.map(el, { scrollWheelZoom: false });
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 18, attribution: '© OpenStreetMap' }).addTo(map);
  const all = [], dot = { radius: 5, color: '#1d2422', fillColor: '#fff', fillOpacity: 1, weight: 2 };
  segs.forEach(sg => {
    const pts = sg.p ? unpoly(sg.p) : []; if (!pts.length) return; all.push(...pts);
    if (sg.m === 'T') {
      L.polyline(pts, { color: sg.c || '#1F4D45', weight: 5, opacity: .85 }).addTo(map).bindTooltip(sg.t || '');
      L.circleMarker(pts[0], dot).addTo(map).bindTooltip(`${sg.a}（${sg.t}に乗る）`);
      L.circleMarker(pts[pts.length - 1], dot).addTo(map).bindTooltip(`${sg.b}（降りる）`);
    } else L.polyline(pts, { color: '#5d6b67', weight: 3, dashArray: '4 6' }).addTo(map);
  });
  if (!all.length) return;
  L.circleMarker(all[all.length - 1], { radius: 7, color: '#b3261e', fillColor: '#b3261e', fillOpacity: 1 }).addTo(map).bindTooltip(f.name, { permanent: true, direction: 'top' });
  setTimeout(() => { map.invalidateSize(); map.fitBounds(all, { padding: [24, 24] }); }, 60);
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
