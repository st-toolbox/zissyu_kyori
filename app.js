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
  ({ fac: renderFac, stu: renderStu, calc: renderCalc, asg: renderAsg, prt: renderPrt, tch: renderTch, set: renderSet })[S.view]();
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
// 住所からの経路（駅を通さない）の内訳の1行
const doorBrk = o => `${o.k === '実家の住所から' ? '実家の住所から' : '住所から'}：歩き${o.d.walk1 ?? 0} ＋ ${o.d.lines ? '電車・バス' + (o.d.transfers ? '（乗換' + o.d.transfers + '）' : '') : '歩きだけ'} ＋ 歩き${o.d.walk2 ?? 0}`;
const hasDoor = sid => ['door', 'doorJk'].some(k => Object.keys(((Y()[k] || {})[sid]) || {}).length > 0);   // 住所から分が出ている＝駅が空でも通える先がある
const doorJkOf = (sid, fid) => (((Y().doorJk || {})[sid]) || {})[fid];   // 実家の住所から
// 住所から：施設に着きたい時刻＝始業−ゆとり
function doorArrive(fid) {
  const [h, m] = startOf(fid).split(':').map(Number);
  const t = h * 60 + m - (num(S.settings.yutori) || 0);
  return String(Math.floor(t / 60)).padStart(2, '0') + ':' + String(t % 60).padStart(2, '0');
}

function bases(s) {
  const out = [];
  if (s.st && num(s.min) != null) out.push({ k: 'ふだん', st: s.st, kind: s.stKind || '電車', loc: s.stLoc || null, mode: s.mode || '徒歩', min: num(s.min) });
  if (!s.home && s.jk && s.jk.ok && s.jk.st) out.push({ k: '実家', st: s.jk.st, kind: s.jk.kind || '電車', loc: s.jk.loc || null, mode: s.jk.mode || '徒歩', min: num(s.jk.min) || 0 });
  return out;
}

// 学生×施設の片道。いちばん短い通い方を返す
function evalPair(sid, fid) {
  const s = students()[sid] || {}, f = S.facilities[fid] || {};
  const opts = []; let pending = false, errs = [];
  const l3 = leg3(f), arr = arriveBy(fid), door = doorOf(sid, fid), dj = !s.home && s.jk && s.jk.ok ? doorJkOf(sid, fid) : null;
  // 住所からの分があれば、その駅の見積もりの代わりにそれを使う（最終）。実家は「実家から可」の学生だけ
  if (door && door.min != null) opts.push({ k: '住所から', total: door.min, d: door });
  else if (door && door.err) errs.push('住所から：' + door.err);
  if (dj && dj.min != null) opts.push({ k: '実家の住所から', total: dj.min, d: dj });
  else if (dj && dj.err) errs.push('実家の住所から：' + dj.err);
  for (const b of bases(s)) {
    if (b.k === 'ふだん' && door && door.min != null) continue;
    if (b.k === '実家' && dj && dj.min != null) continue;
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
  if (best && best.k !== '車' && !best.d && (f.access || '徒歩') === '徒歩' && num(f.bike) != null && num(f.bike) < num(f.walk) && best.total > num(S.settings.ok)) {
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
          [`facilities/${fid}/loc`]: geos[k] && geos[k].lat != null ? geos[k].lat + ',' + geos[k].lng : null, [`facilities/${fid}/draft`]: true, [`facilities/${fid}/walk`]: r.walk ?? null, [`facilities/${fid}/bike`]: r.bike ?? null, [`facilities/${fid}/access`]: null });
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
      <td>${s.carDirect ? '可' : ''}</td><td>${s.home ? '<span class="tag">いま実家に住んでいる</span>' : jk.ok ? '可：' + esc(stLabel(jk.st || '?', jk.kind)) + (jk.min != null ? '（' + esc(jk.mode || '') + jk.min + '分）' : '') + (jk.st && stClean(jk.st, jk.kind) === stClean(s.st, s.stKind) ? ' <span class="tag yel" title="実家の駅がふだんの駅と同じ。いま実家に住んでいるなら、押して「いま実家に住んでいる」にする">ふだんと同じ駅</span>' : '') : ''}</td>
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
  fm.jkOk.value = s.home ? 'home' : jk.ok ? '1' : ''; fm.jkSt.value = stClean(jk.st, jk.kind); fm.jkKind.value = jk.kind || '電車'; fm.jkMode.value = jk.mode || '徒歩'; fm.jkMin.value = jk.min == null ? '' : jk.min;
  $('stu-del').style.display = sid ? '' : 'none';
  $('stu-del').onclick = async () => {
    if (!confirm(`${s.name}を${S.year}年度から消す？（この年度の配置と車の分数も消える）`)) return;
    const up = { [ypath('students/' + sid)]: null, [ypath('car/' + sid)]: null, [ypath('door/' + sid)]: null, [ypath('doorJk/' + sid)]: null };
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
      home: fm.jkOk.value === 'home',
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
  // 学籍番号は大文字小文字・全角半角を同じとみなし、名簿にある番号の書き方を残す（フォームの取り込みと同じ・2026-10-22）
  const nId = v => fk(String(v || '').normalize('NFKC').toUpperCase());
  const known = {}; Object.keys(students()).forEach(k => { known[nId(k)] = k; });
  for (const r of rows) {
    if (!r[0] || r[0] === '学籍番号') continue;
    const id = known[nId(r[0])] || (known[nId(r[0])] = fk(r[0]));
    const s = { ...(up[ypath('students/' + id)] || students()[id] || {}) };
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
    if (g(11)) { if (/実家に住/.test(g(11))) s.home = true; s.jk.ok = yes(g(11)) && !s.home; }
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

// Google フォーム（gas/Form.gs で作る）の回答の表を見出しごと貼る。見出しで読む＝列の順は問わない
// ⚠️ 見出しは Form.gs の質問の文そのもの。メールアドレスの列は読まない（残さない）
const FORM_Q = { ts: 'タイムスタンプ', sid: '学籍番号', name: '名前', ped: '小児の希望', st: 'ふだん使う駅・バス停の名前', kind: 'その種類', mode: 'そこまでの手段',
  min: '家を出てから乗るまでの分', car: '車で実習先まで直接通えますか', jkOk: '実家からの実習',
  jkSt: '実家の最寄りの駅・バス停の名前', jkKind: '実家の駅の種類', jkMode: '実家から駅までの手段', jkMin: '実家を出てから乗るまでの分' };
const formKind = v => /バス/.test(v) ? 'バス' : /路面|電停/.test(v) ? '路面電車' : '電車';
$('stu-form').onclick = () => openPaste('フォームの回答を貼り付け', '回答の表（スプレッドシート）を見出しの行ごと全部選んでコピーして貼る。同じ学籍番号は新しい回答で上書き。実習の種別（評価・総合・見学）はそのまま残す。', importForm);
// 回答の表を直接読む＝ログインに「表を読む」許可を足して Sheets API で1枚目を取る（5. 印刷で保存した回答の表）
$('stu-form-sheet').onclick = async () => {
  const id = (((Y().form || {}).sheet || '').match(/\/spreadsheets\/d\/([\w-]+)/) || [])[1];
  if (!id) return toast(`${S.year}年度の「回答の表」の URL が無い＝5. 印刷のフォームの箱で保存する`);
  try {
    const pv = new firebase.auth.GoogleAuthProvider();
    pv.addScope('https://www.googleapis.com/auth/spreadsheets.readonly');
    const cred = await auth.currentUser.reauthenticateWithPopup(pv);
    const r = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${id}/values/A:Z`, { headers: { Authorization: 'Bearer ' + cred.credential.accessToken } });
    const j = await r.json();
    if (!r.ok) return toast(r.status === 403 || r.status === 404
      ? `回答の表を読めなかった（${r.status}）＝この先生のアカウントに表を共有する／Google Cloud で Sheets API を有効にする`
      : '回答の表を読めなかった：' + ((j.error || {}).message || r.status));
    await importForm((j.values || []).map(row => row.map(c => String(c).trim())));
  } catch (e) { fail(e); }
};
async function importForm(rows) {
  const head = (rows[0] || []).map(c => c.trim()), col = {};
  for (const [k, t] of Object.entries(FORM_Q)) col[k] = head.indexOf(t);
  if (col.sid < 0 || col.st < 0) return alert('見出しの行が見つからない。1行目（タイムスタンプ・学籍番号…）からコピーして貼る');
  const up = {}, seen = {}, miss = []; let n = 0, skip = 0;
  // 学籍番号はアプリの名簿のものを変えない：番号が名簿に無ければ名前で名簿の学生に当てる・当たらなければ取り込まない（名簿が空の年度だけ新しく足す）
  const roster = students(), hasRoster = Object.keys(roster).length > 0;
  const nId = v => fk(String(v || '').normalize('NFKC').toUpperCase()), nNm = v => String(v || '').normalize('NFKC').replace(/\s/g, '');
  const byId = {}, byName = {};
  Object.entries(roster).forEach(([sid, x]) => { byId[nId(sid)] = sid; const k = nNm(x.name); if (k) (byName[k] = byName[k] || []).push(sid); });
  for (const r of rows.slice(1)) {
    const g = k => col[k] < 0 || r[col[k]] === undefined ? '' : String(r[col[k]]).trim();
    if (!g('sid') && !g('name')) { skip++; continue; }
    let id = byId[nId(g('sid'))];
    if (!id) { const c = byName[nNm(g('name'))]; if (c && c.length === 1) id = c[0]; }
    if (!id) { if (hasRoster) { miss.push(`${g('sid') || '（番号なし）'} ${g('name')}`); continue; } id = fk(g('sid')); if (!id) { skip++; continue; } }
    const s = { ...(seen[id] || roster[id] || {}) };   // 同じ人が2回答えていたら後の行（新しい方）で上書き
    if (g('name') && !roster[id]) s.name = g('name');   // 名簿にいる学生の名前もそのまま
    if (g('ped')) s.ped = /^希望する/.test(g('ped'));   // 2026-10-22 フォームに足した設問（前の回答には無い＝今の値のまま）
    const st = stClean(g('st'), formKind(g('kind'))), kind = formKind(g('kind'));
    if (st !== stClean(s.st, s.stKind) || kind !== (s.stKind || '電車')) { s.stLoc = null; s.stAddr = null; }
    s.st = st; s.stKind = kind;
    s.mode = MODES.includes(g('mode')) ? g('mode') : '徒歩'; s.min = num(g('min'));
    s.carDirect = g('car') === 'はい';
    if (/実家に住/.test(g('jkOk'))) s.home = true;   // 先生が「いま実家に住んでいる」にした学生は、フォームで「可」でもそのまま
    const jk = { ...(s.jk || {}) }; jk.ok = /^可/.test(g('jkOk')) && !s.home;
    if (jk.ok) {
      const js = stClean(g('jkSt'), formKind(g('jkKind'))), jkind = formKind(g('jkKind'));
      if (js !== stClean(jk.st, jk.kind) || jkind !== (jk.kind || '電車')) { jk.loc = null; jk.addr = null; }
      Object.assign(jk, { st: js, kind: jkind, mode: MODES.includes(g('jkMode')) ? g('jkMode') : '徒歩', min: num(g('jkMin')) });
    }
    s.jk = jk;
    const m = g('ts').match(/(\d{4})\D(\d{1,2})\D(\d{1,2})/);
    s.slip = m ? `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}（フォーム）` : 'フォーム';
    if (!students()[id] && !seen[id]) s.t = {};
    seen[id] = s; up[ypath('students/' + id)] = s;
  }
  n = Object.keys(seen).length;
  if (miss.length) alert(`名簿の学籍番号にも名前にも当たらない回答が${miss.length}件＝取り込んでいない（学籍番号は名簿のものを使う）。\n${miss.join('\n')}\n\n学生の画面で名簿の名前を回答と同じにするか、学生を足してからもう一度取り込む`);
  if (!n) return toast('取り込める回答がなかった');
  const nNew = Object.values(seen).filter(s => !Object.values(s.t || {}).some(Boolean)).length;
  await db.ref().update(up);
  toast(`${n}人の回答を取り込んだ${skip ? `（学籍番号が空の${skip}行は飛ばした）` : ''}${nNew ? `。実習の種別が未設定の学生が${nNew}人＝学生の画面で付ける` : ''}`);
  const k = await locateStops(Object.keys(seen));
  if (k) toast(`${n}人を取り込んだ。バス停・電停 ${k}件の場所を地図で読んだ（学生の画面で確かめられる）`);
}
$('prt-form').onclick = async () => {
  try {
    const src = await (await fetch('gas/Form.gs', { cache: 'no-store' })).text();
    await navigator.clipboard.writeText(src);
    toast('フォームを作るスクリプトをコピーした。下の手順で貼って動かす');
  } catch (e) { fail(e); }
};
// フォームの3つのリンク（年度ごと・years/<年度>/form）
const FORM_LINKS = [['pub', '学生に配る URL'], ['edit', 'フォームを直す URL'], ['sheet', '回答の表']];
function renderPrt() {
  const f = Y().form || {};
  $('form-links').innerHTML = FORM_LINKS.map(([k, l]) => `<div class="row"><label style="min-width:9em">${l}</label>
    <input id="fl-${k}" type="url" style="flex:1;min-width:16em" value="${esc(f[k] || '')}" placeholder="https://...">
    <button data-fl-open="${k}">開く</button><button data-fl-copy="${k}">コピー</button></div>`).join('');
  document.querySelectorAll('[data-fl-open]').forEach(b => b.onclick = () => {
    const u = $('fl-' + b.dataset.flOpen).value.trim();
    if (/^https:\/\//.test(u)) window.open(u, '_blank', 'noopener'); else toast('URL が入っていない');
  });
  document.querySelectorAll('[data-fl-copy]').forEach(b => b.onclick = async () => {
    const u = $('fl-' + b.dataset.flCopy).value.trim();
    if (!u) return toast('URL が入っていない');
    try { await navigator.clipboard.writeText(u); toast('コピーした'); } catch (e) { fail(e); }
  });
}
$('form-links-save').onclick = async () => {
  const v = {};
  for (const [k, l] of FORM_LINKS) {
    const u = $('fl-' + k).value.trim();
    if (u && !/^https:\/\/(docs\.google\.com|forms\.gle)\//.test(u)) return toast(`${l} が Google の URL でない`);
    v[k] = u || null;
  }
  try { await db.ref(ypath('form')).update(v); toast(`${S.year}年度のフォームのリンクを保存した`); } catch (e) { fail(e); }
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
const addrJkOf = sid => (S.addrJk || {})[sid] || '';   // 実家の住所（これも保存しない）
const jkOk = sid => { const s = students()[sid] || {}; return !s.home && !!(s.jk || {}).ok; };
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
  const D = doorOf(sid, fid), J = doorJkOf(sid, fid), ev = evalPair(sid, fid);
  const waitJ = addrJkOf(sid) && jkOk(sid) && !(J && (J.min != null || J.err));   // 実家の住所を入れたのにまだ出ていない
  if (D && D.min != null && !waitJ) return { st: 'done', ev, src: '住' };
  if ((addrOf(sid) && !(D && (D.min != null || D.err))) || waitJ) return { st: 'todo', ev };
  if (J && J.min != null && jkOk(sid)) return { st: 'done', ev, src: '住' };
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
        if (b.k === '実家' && ((doorJkOf(sid, fid) || {}).min != null || addrJkOf(sid))) continue;
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
    // 実家の住所（実家から可の学生だけ）は ふだん と同じやり方で、door ではなく doorJk に入れる
    const fj = jkOk(sid) ? addrJkOf(sid) : '', DJ = (Y().doorJk || {})[sid] || {};
    if (fj) {
      const fs = doorFacs(sid).filter(fid => fids.has(fid) && want(mode, DJ[fid] && (DJ[fid].min != null || DJ[fid].err), DJ[fid] && DJ[fid].err));
      if (fs.length) doorJ.push({ sid, from: fj, fs, jk: true });
    }
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
        stage = `${j.jk ? '実家の' : ''}住所から：${nm}（施設 ${i + 1}〜${i + part.length} / ${j.fs.length}）`; show();
        const res = await gas('door', part.map(fid => ({ from: j.from, to: S.facilities[fid].address, arrive: doorArrive(fid) })));
        part.forEach((fid, k) => { const r = res[k] || { err: '応答なし' }; up[ypath(`${j.jk ? 'doorJk' : 'door'}/${j.sid}/${fid}`)] = { ...r, arrive: doorArrive(fid), at: now() }; });
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
  const nAddr = sids.filter(sid => addrOf(sid) || addrJkOf(sid)).length;
  const walkTodo = Object.keys(S.facilities).filter(fid => { const f = S.facilities[fid]; return f.station && f.address && (f.access || '徒歩') === '徒歩' && f.walk == null; }).length;
  const noBase = sids.filter(sid => !bases(students()[sid]).length && !addrOf(sid) && !addrJkOf(sid) && !Object.keys(((Y().door || {})[sid]) || {}).length).length;
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
$('calc-sum').onclick = e => { if (e.target.id === 'addr-clear' && confirm('読み込んだ住所（ふだん・実家）を消す？（出た分数は残る）')) { S.addr = {}; S.addrJk = {}; renderCalc(); } };
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
  $('scope-addr-jk').value = scope.sid ? addrJkOf(scope.sid) : '';
  d.returnValue = '';
  d.onclose = () => {
    const m = d.returnValue; if (!MODE_LABEL[m]) return;
    if (scope.sid) {
      const a = $('scope-addr').value.trim(), b = $('scope-addr-jk').value.trim(); S.addr = S.addr || {}; S.addrJk = S.addrJk || {};
      if (a) S.addr[scope.sid] = a; else delete S.addr[scope.sid];
      if (b) S.addrJk[scope.sid] = b; else delete S.addrJk[scope.sid];
    }
    $('scope-addr').value = ''; $('scope-addr-jk').value = '';
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
// 住所の表：1行＝1人（学籍番号順）。ふだんの住所と実家の住所のセルに Excel から貼る
// 貼ると選んだセルから右下へ広がる。貼った表に学籍番号か名前の列があれば、その行の学生に当てる（順番が違っても合う）
const addrGridSids = () => Object.keys(students()).sort();
const gridCell = (r, c) => $('addr-grid').querySelector(`input[data-r="${r}"][data-c="${c}"]`);
function openAddrGrid() {
  const sids = addrGridSids();
  if (!sids.length) return toast('学生がまだいない（2. 学生）');
  $('addr-grid').innerHTML = `<tr><th>学籍番号</th><th>名前</th><th>ふだんの住所</th><th>実家の住所</th></tr>` + sids.map((sid, r) => {
    const s = students()[sid];
    return `<tr data-sid="${esc(sid)}"><td>${esc(sid)}</td><td>${esc(s.name || '')}${s.home ? ' <span class="tag">実家に住んでいる</span>' : jkOk(sid) ? '' : ' <span class="tag" title="実家の住所を入れると、使うときに「実家から可」にするか聞く">実家 未</span>'}</td>` +
      `<td><input type="text" data-r="${r}" data-c="0" value="${esc(addrOf(sid))}" autocomplete="off"></td><td><input type="text" data-r="${r}" data-c="1" value="${esc(addrJkOf(sid))}" autocomplete="off"></td></tr>`;
  }).join('');
  addrGridCount();
  const d = $('dlg-addr'); d.returnValue = '';
  d.onclose = () => { if (d.returnValue === 'ok') saveAddrGrid().catch(fail); };
  d.showModal();
  const first = gridCell(0, 0); if (first) first.focus();
}
function addrGridCount() {
  const ins = [...$('addr-grid').querySelectorAll('input')];
  const n0 = ins.filter(i => i.dataset.c === '0' && i.value.trim()).length, n1 = ins.filter(i => i.dataset.c === '1' && i.value.trim()).length;
  $('addr-grid-n').textContent = `ふだん ${n0}人・実家 ${n1}人`;
}
// 貼った表の1行から住所のセルだけ拾う（メール・郵便番号・電話は飛ばす）
const addrCells = r => r.filter(c => c && !/@/.test(c) && !/^〒?\s*\d{3}-?\d{4}$/.test(c) && !/^[\d\-()（） ]{10,}$/.test(c));
$('addr-grid').addEventListener('paste', e => {
  const t = e.target; if (!t.matches || !t.matches('input[data-r]')) return;
  const raw = (e.clipboardData || window.clipboardData).getData('text');
  if (!/[\t\n]/.test(raw.replace(/\r?\n$/, ''))) return;   // 1セル分ならふつうに貼る
  e.preventDefault();
  let rows = readSheet(raw);
  const all = students(), sidOf = {}, byName = {};
  Object.keys(all).forEach(sid => { sidOf[nz(sid)] = sid; const n = nz(all[sid].name); if (n) byName[n] = byName[n] === undefined ? sid : null; });
  const who = c => sidOf[nz(c)] || sidOf[nz(fk(c))] || byName[nz(c)] || null;
  // 見出し行があれば、実家の列とふだんの住所の列（分かれていればつなぐ）を見出しで決める
  let jkCol = -1, homeCols = null;
  if (rows.length && !rows[0].some(who) && rows[0].some(c => /住所|実家|所在地/.test(c))) {
    const h = rows[0]; jkCol = h.findIndex(c => /実家|帰省/.test(c));
    homeCols = h.map((c, k) => k !== jkCol && /住所|所在地|都道府県|市区町村|町名|番地|建物|方書/.test(c) && !/メール|mail/i.test(c) ? k : -1).filter(k => k >= 0);
    rows = rows.slice(1);
  }
  let n = 0;
  if (rows.some(r => r.some(who))) {
    // 学籍番号か名前の列がある＝その学生の行へ
    rows.forEach(r => {
      const k = r.findIndex(who); if (k < 0) return;
      const sid = who(r[k]), tr = $('addr-grid').querySelector(`tr[data-sid="${CSS.escape(sid)}"]`); if (!tr) return;
      const rest = r.map((c, x) => x === k || nz(c) === nz(all[sid].name) ? '' : c);
      let home, jk;
      if (homeCols) { home = homeCols.map(x => rest[x] || '').join(' ').trim(); jk = jkCol >= 0 ? rest[jkCol] || '' : ''; }
      else { const cs = addrCells(rest); home = cs[0] || ''; jk = cs[1] || ''; }
      const ins = tr.querySelectorAll('input');
      if (home) { ins[0].value = home; n++; } if (jk) { ins[1].value = jk; n++; }
    });
    toast(n ? `学籍番号・名前で ${n}セル入れた` : '学籍番号・名前が合う行が無い');
  } else {
    // 住所だけ＝選んだセルから右下へ
    const r0 = +t.dataset.r, c0 = +t.dataset.c;
    rows.forEach((r, i) => r.slice(0, 2 - c0).forEach((v, j) => { const el = gridCell(r0 + i, c0 + j); if (el) { el.value = v; n++; } }));
    const over = rows.length - (addrGridSids().length - r0);
    toast(over > 0 ? `${n}セル入れた（${over}行は学生の数を超えたので入れていない）` : `${n}セル入れた`);
  }
  addrGridCount();
});
// Enter・上下の矢印で上下に動く（Excel と同じ。Shift+Enter で上）
$('addr-grid').addEventListener('keydown', e => {
  const t = e.target; if (!t.matches || !t.matches('input[data-r]') || e.isComposing) return;
  const go = e.key === 'Enter' ? (e.shiftKey ? -1 : 1) : e.key === 'ArrowDown' ? 1 : e.key === 'ArrowUp' ? -1 : 0;
  if (!go) return;
  e.preventDefault(); const el = gridCell(+t.dataset.r + go, +t.dataset.c); if (el) { el.focus(); el.select(); }
});
$('addr-grid').addEventListener('input', addrGridCount);
$('addr-grid-clear').onclick = () => { if (!confirm('表の住所を全部消す？')) return; $('addr-grid').querySelectorAll('input').forEach(i => i.value = ''); addrGridCount(); };
async function saveAddrGrid() {
  S.addr = {}; S.addrJk = {};
  $('addr-grid').querySelectorAll('tr[data-sid]').forEach(tr => {
    const sid = tr.dataset.sid, ins = tr.querySelectorAll('input'), a = ins[0].value.trim(), b = ins[1].value.trim();
    if (a) S.addr[sid] = a; if (b) S.addrJk[sid] = b;
  });
  // 実家の住所を入れたのに「実家から可」になっていない学生
  const ng = Object.keys(S.addrJk).filter(sid => !jkOk(sid) && !(students()[sid] || {}).home);   // いま実家に住んでいる学生の実家の住所は使わない
  if (ng.length && confirm(`実家の住所を入れた学生のうち ${ng.length}人は「実家から可」になっていない。\n${ng.map(sid => sid + ' ' + (students()[sid].name || '')).join('\n')}\n\n「実家から可」にする？（しないと実家の住所は計算に使わない）`)) {
    const up = {}; ng.forEach(sid => up[ypath(`students/${sid}/jk/ok`)] = true);
    await db.ref().update(up);
  }
  renderCalc();
  const n0 = Object.keys(S.addr).length, n1 = Object.keys(S.addrJk).filter(jkOk).length;
  if (!n0 && !n1) return toast('住所を空にした');
  if (confirm(`住所を入れた（ふだん ${n0}人・実家 ${n1}人・保存していない）。\n\nこのまま「まだの分を計算」する？`)) askRun({}, 'todo', '全部');
}
$('addr-paste').onclick = openAddrGrid;

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
  $('asg-stats').innerHTML = `<div class="clk" data-pl="all" title="押すと今の配置の一覧"><span class="k">決まった人</span><b>${placed.length}</b> / ${sids.length}</div>
    <div class="clk" data-pl="stay" title="押すと宿泊になる配置の一覧"><span class="k">宿泊になる配置</span><b style="color:${stay ? 'var(--bad)' : 'inherit'}">${stay}</b>件</div>
    <div class="clk" data-pl="all" title="押すと今の配置の一覧（片道の長い順）"><span class="k">いちばん長い片道</span><b>${fmtMin(longest)}</b> <span class="hint">${esc(longestWho)}</span></div>
    <div><span class="k">施設（受入あり）</span><b>${fids.length}</b></div>`;

  // 施設の埋まり具合
  const cnt = {}; placed.forEach(sid => cnt[A[sid].fid] = (cnt[A[sid].fid] || 0) + 1);
  // 枠が残っている施設：宿泊なしで通える「まだ決まっていない人」が残りの枠より少ない・通える人がもともと少ない、なら色で知らせる
  $('asg-fill').innerHTML = fids.map(fid => {
    const cap = num(yFac(fid).cap[t]), c = cnt[fid] || 0, rest = cap - c;
    const rs = reachersOf(fid, evs), free = rs.filter(sid => !A[sid]);
    let cls = c > cap ? 'over' : c === cap ? 'full' : '', tip = '';
    if (rest > 0) {
      if (!free.length) { cls = 'zero'; tip = '通えるまだ決まっていない人がいない'; }
      else if (free.length <= rest) { cls = 'tight'; tip = `残り${rest}枠に通える人${free.length}人`; }
      else if (rs.length <= 3) { cls = 'few'; tip = `通えるのは${rs.length}人だけ`; }
      if (free.length) tip += `（${free.map(sid => students()[sid].name).join('・')}）`;
    }
    tip = (tip ? tip + '\n' : '') + '押すと通える学生の一覧';
    return `<span class="${cls}${S.facOpen === fid ? ' on' : ''}" data-fid="${esc(fid)}" title="${esc(tip)}">${esc(S.facilities[fid].name)} ${c}/${cap}</span>`;
  }).join('') + '<span class="lg"><i class="zero"></i>通える人がもういない <i class="tight"></i>通える人が残りの枠以下 <i class="few"></i>通えるのが3人以下（宿泊なし・名前にマウスで誰か）</span>';

  renderFacPop(fids, evs, A, cnt);
  renderPlaced(sids, evs, A);

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
    return `<div class="it ${sid === S.sel ? 'sel' : ''}" data-sid="${esc(sid)}"><div class="nm">${esc(s.name)}${s.ped ? '<span class="tag blu">小児希望</span>' : ''}${bases(s).length || hasDoor(sid) ? '' : '<span class="tag red">駅が未入力</span>'}</div><div class="sub">${sub}</div></div>`;
  }).join('') || '<div class="it hint">この種別の学生がいない（学生の画面で「この年度の実習」に印）</div>';

  renderCands(fids, evs, A, cnt, lock);
}

// 施設ごとに「宿泊なしで通える学生」
// 上の数字を押したとき：今の配置の一覧（片道の長い順）。宿泊のときは宿泊になる配置だけ
function renderPlaced(sids, evs, A) {
  const box = $('asg-placed'), mode = S.plOpen;
  $('asg-stats').querySelectorAll('[data-pl]').forEach(d => d.classList.toggle('on', d.dataset.pl === mode));
  if (!mode) { box.innerHTML = ''; box.hidden = true; return; }
  const rows = sids.filter(sid => A[sid] && S.facilities[A[sid].fid]).map(sid => {
    const fid = A[sid].fid, ev = evs[sid][fid] || evalPair(sid, fid);
    return { sid, fid, ev, total: ev.best ? ev.best.total : null, stay: isStay(ev) };
  }).filter(r => mode !== 'stay' || r.stay).sort((a, b) => (b.total ?? 1e9) - (a.total ?? 1e9));
  const yet = sids.filter(sid => !(A[sid] && S.facilities[A[sid].fid]));
  box.hidden = false;
  box.innerHTML = `<div class="hd"><b>${mode === 'stay' ? '宿泊になる配置' : '今の配置'}</b> <span class="hint">${rows.length}人・片道の長い順・名前を押すとその学生の候補へ</span><button class="small" id="asg-placed-x">閉じる</button></div>` +
    (rows.length ? `<table>${rows.map(r => { const mk = mark(r.total); return `<tr class="clk" data-sid="${esc(r.sid)}"><td>${esc(students()[r.sid].name)}</td><td>${esc(S.facilities[r.fid].name)}</td><td class="${mk.c}">${mk.m} ${fmtMin(r.total)}</td><td>${r.stay ? '<span class="tag red">宿泊</span>' : ''}${r.ev.best && r.ev.best.k && r.ev.best.k !== 'ふだん' && r.ev.best.k !== '住所から' ? ` <span class="tag">${esc(r.ev.best.k)}</span>` : ''}</td></tr>`; }).join('')}</table>` : '<div class="hint">まだ無い</div>') +
    (mode === 'all' && yet.length ? `<div class="hint" style="margin-top:6px">まだ決まっていない ${yet.length}人：${yet.map(sid => `<a href="#" data-sid="${esc(sid)}">${esc(students()[sid].name)}</a>`).join('・')}</div>` : '');
}
// 施設の札を押したとき：その施設に宿泊なしで通える学生（近い順）と、今どこに決まっているか
function renderFacPop(fids, evs, A, cnt) {
  const box = $('asg-fac'), fid = S.facOpen;
  if (!fid || !fids.includes(fid)) { S.facOpen = null; box.innerHTML = ''; box.hidden = true; return; }
  const t = S.type, cap = num(yFac(fid).cap[t]), c = cnt[fid] || 0;
  const rs = reachersOf(fid, evs).sort((a, b) => evs[a][fid].best.total - evs[b][fid].best.total);
  const stayN = Object.keys(evs).filter(sid => evs[sid][fid] && evs[sid][fid].best && isStay(evs[sid][fid])).length;
  const rows = rs.map(sid => {
    const ev = evs[sid][fid], mk = mark(ev.best.total), cur = A[sid] && S.facilities[A[sid].fid] ? A[sid].fid : null;
    const st = !cur ? '<span class="tag yel">まだ決まっていない</span>' : cur === fid ? '<span class="tag grn">ここに決定</span>' : `<span class="hint">${esc(S.facilities[cur].name)}に決定</span>`;
    return `<tr class="clk" data-sid="${esc(sid)}"><td>${esc(students()[sid].name)}${students()[sid].ped ? ' <span class="tag blu">小児希望</span>' : ''}</td><td class="${mk.c}">${mk.m} ${fmtMin(ev.best.total)}</td><td>${st}</td></tr>`;
  }).join('');
  box.hidden = false;
  box.innerHTML = `<div class="hd"><b>${esc(S.facilities[fid].name)}</b> <span class="hint">枠 ${c}/${cap}・宿泊なしで通える ${rs.length}人${stayN ? `（宿泊なら ほか${stayN}人）` : ''}・名前を押すとその学生の候補へ</span><button class="small" id="asg-fac-x">閉じる</button></div>` +
    (rs.length ? `<table>${rows}</table>` : '<div class="hint">宿泊なしで通える学生はいない</div>');
}
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
    ${s.home ? '／いま実家に住んでいる' : ''}${jkOk(sid) ? '／実家から可：' + esc(stName(s.jk.st || '?')) + '駅' : ''}${s.carDirect ? '／車で直接可' : ''}${s.ped ? '／小児希望' : ''}</div>
    ${curF ? `<div style="margin-top:6px">配置：<b>${esc(curF.name)}</b> <span class="hint">${esc(cur.by || '')} ${fmtAt(cur.at)}${cur.reason ? '／変更の理由：' + esc(cur.reason) : ''}</span>
      <button class="small danger" data-act="remove">外す</button></div>` : ''}</div>`;
  h += `<table class="cands"><tr><th></th><th>施設</th><th class="num">片道</th><th>内訳</th><th>印</th><th></th></tr>`;
  let sepDone = false;
  for (const r of rows) {
    if (r.warned && !sepDone) { h += `<tr class="sep"><td colspan="6">受入がいっぱい・過去に行った施設（選べるが警告つき）</td></tr>`; sepDone = true; }
    const b = r.ev.best, mk = mark(b && b.total);
    let brk = '';
    if (b && b.k === '車') brk = '車で直接';
    else if (b && b.d) brk = esc(doorBrk(b));
    else if (b) brk = `${b.k === '実家' ? '実家から：' : ''}①${esc(b.b.mode)}${b.b.min} ＋ ②電車・バス${b.r.ride}${b.r.transfers ? '（乗換' + b.r.transfers + '）' : ''} ＋ ③${esc(r.f.access && r.f.access !== '徒歩' ? r.f.access : '徒歩')}${b.l3}`;
    else if (r.ev.errs.length) brk = esc(r.ev.errs.join('／'));
    else brk = '未計算';
    const tags = [];
    if (b && (b.k === '実家' || b.k === '実家の住所から')) tags.push('<span class="tag grn">実家から</span>');
    if (b && ((b.r && b.r.shinkansen) || (b.d && b.d.shinkansen))) tags.push('<span class="tag yel">新幹線</span>');
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
$('asg-stats').onclick = e => { const d = e.target.closest('[data-pl]'); if (!d) return; S.plOpen = S.plOpen === d.dataset.pl ? null : d.dataset.pl; renderAsg(); };
$('asg-placed').onclick = e => {
  if (e.target.closest('#asg-placed-x')) { S.plOpen = null; return renderAsg(); }
  const r = e.target.closest('[data-sid]'); if (r) { e.preventDefault(); S.sel = r.dataset.sid; renderAsg(); }
};
$('asg-fill').onclick = e => { const b = e.target.closest('span[data-fid]'); if (!b) return; S.facOpen = S.facOpen === b.dataset.fid ? null : b.dataset.fid; renderAsg(); };
$('asg-fac').onclick = e => {
  if (e.target.closest('#asg-fac-x')) { S.facOpen = null; return renderAsg(); }
  const tr = e.target.closest('tr[data-sid]'); if (tr) { S.sel = tr.dataset.sid; renderAsg(); }
};
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
    h += `<div class="box"><b><span class="mk ${mk.c}">${mk.m}</span> ${o.k === '車' ? '車で直接' : o.k === '住所から' ? '家の住所から（電車・バス）' : o.k === '実家の住所から' ? '実家の住所から（電車・バス）' : o.k + 'の駅から'}：${fmtMin(o.total)}</b>`;
    if (o.d) {
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
  document.querySelectorAll('#detail-body .rmap').forEach(el => drawRoute(el, ev.opts[+el.dataset.i], f, fid));
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
// 大まかな経路を地図に描く（就職マップと同じ地図）：電車・バスは色の実線、歩きは点線。乗る所・降りる所に名前（家から乗る所までの線は持っていない）
async function drawRoute(el, o, f, fid) {
  const walkOk = (f.access || '徒歩') === '徒歩';
  const segs = o.d ? (o.d.poly || []) : (o.r.poly || []).concat(o.r.poly && f.walkPoly && walkOk ? [{ m: 'W', p: f.walkPoly }] : []);
  if (!segs.length || !window.maplibregl) { el.outerHTML = `<div class="hint" style="margin:6px 0 0">${window.maplibregl ? '地図の線が無い（地図の機能より前に計算した）。3. 計算の表でこのマスを押して「上書き」でやり直すと出る。' : '地図を読み込めなかった（ネットにつながっているか）。'}</div>`; return; }
  // 施設の場所（前の計算では持っていない＝1回だけ調べて残す。施設の住所なので残してよい）
  if (!f.loc && f.address && S.settings.gasUrl) {
    try { const g = (await gas('geo', [{ address: f.address }]))[0]; if (g && g.lat != null) { f.loc = g.lat + ',' + g.lng; db.ref(`facilities/${fid}/loc`).set(f.loc); } } catch (e) { }
  }
  const ll = p => [p[1], p[0]], feats = [], stops = [], all = [];
  segs.forEach(sg => {
    const pts = sg.p ? unpoly(sg.p).map(ll) : []; if (!pts.length) return; all.push(...pts);
    feats.push({ type: 'Feature', properties: { T: sg.m === 'T' ? 1 : 0, c: sg.c || '#1F4D45' }, geometry: { type: 'LineString', coordinates: pts } });
    if (sg.m === 'T') stops.push([pts[0], `${sg.a}（${sg.t}に乗る）`], [pts[pts.length - 1], `${sg.b}（降りる）`]);
  });
  if (!all.length) return;
  const end = all[all.length - 1], fp = f.loc ? f.loc.split(',').map(Number).reverse() : null;
  // 降りた所から施設までの歩きの線が無いとき（駅からの経路）は、施設までまっすぐ点線
  if (fp && Math.hypot((fp[0] - end[0]) * Math.cos(end[1] * Math.PI / 180), fp[1] - end[1]) > 0.0004) {
    feats.push({ type: 'Feature', properties: { T: 0, c: '' }, geometry: { type: 'LineString', coordinates: [end, fp] } }); all.push(fp);
  }
  const map = new maplibregl.Map({ container: el, style: 'mapstyle.json', bounds: boundsOf(all), fitBoundsOptions: { padding: 30 }, scrollZoom: false, attributionControl: { compact: true } });
  map.addControl(new maplibregl.NavigationControl({ showCompass: false }));
  setTimeout(() => { map.resize(); map.fitBounds(boundsOf(all), { padding: 30, duration: 0 }); const a = el.querySelector('.maplibregl-compact-show'); if (a) a.classList.remove('maplibregl-compact-show'); }, 60);   // ダイアログが開ききってから大きさを測り直す
  map.on('load', () => {
    map.addSource('rt', { type: 'geojson', data: { type: 'FeatureCollection', features: feats } });
    map.addLayer({ id: 'rt-w', type: 'line', source: 'rt', filter: ['==', ['get', 'T'], 0], paint: { 'line-color': '#5d6b67', 'line-width': 3, 'line-dasharray': [1, 2] } });
    map.addLayer({ id: 'rt-t', type: 'line', source: 'rt', filter: ['==', ['get', 'T'], 1], layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': ['get', 'c'], 'line-width': 5, 'line-opacity': .85 } });
  });
  stops.forEach(([p, t]) => new maplibregl.Marker({ element: pin('rpin', t), anchor: 'left', offset: [-7, 0] }).setLngLat(p).addTo(map));
  new maplibregl.Marker({ anchor: 'left', offset: [-9, 0], element: pin('rpin fac', f.name + (fp ? '' : '（場所を調べられず・最寄りの停留所に置いた）')) }).setLngLat(fp || end).addTo(map);
}
function boundsOf(pts) {
  const b = new maplibregl.LngLatBounds(pts[0], pts[0]); pts.forEach(p => b.extend(p)); return b;
}
function pin(cls, text) {
  const d = document.createElement('div'); d.className = cls; d.innerHTML = `<i></i><span>${esc(text)}</span>`; return d;
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
    <div class="q"><div class="t">4. 実家からの実習</div>${opt(['可（実家から通ってもよい）', '不可', 'いま実家に住んでいる'])}
      <p class="note">いま実家から通っている人は「いま実家に住んでいる」に○をして、下は書かなくてよい（1. の駅が実家の駅）。</p>
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
  const A = asg(t), lock = (Y().locks || {})[t];
  let h = `<div class="pg list"><h1>${esc(S.year)}年度 ${t}実習 配置一覧</h1><div class="meta">${lock ? '確定：' + esc(lock.by) + ' ' + fmtAt(lock.at) : '（未確定）'}　印刷：${fmtAt(now())}</div>
    <table><tr><th>学生</th><th>施設</th><th>駅</th><th>始業</th><th class="num">片道</th><th>内訳</th><th>印</th></tr>`;
  // 学籍番号順（数字の部分は数として比べる）
  const sids = [...new Set([...studsOf(t), ...Object.keys(A).filter(sid => students()[sid])])]
    .sort((a, b) => a.localeCompare(b, 'ja', { numeric: true }));
  for (const sid of sids) {
    const fid = A[sid] && A[sid].fid, f = fid && S.facilities[fid];
    if (!f) { h += `<tr><td>${esc(students()[sid].name)}</td><td colspan="6" style="color:#888">（未配置）</td></tr>`; continue; }
    const ev = evalPair(sid, fid), b = ev.best, mk = mark(b && b.total);
    const brk = !b ? '' : b.k === '車' ? '車で直接' : b.d ? doorBrk(b) : `${b.k === '実家' ? '実家・' : ''}${stName(b.b.st)}駅 ${b.b.mode}${b.b.min}＋電車${b.r.ride}＋${b.l3}`;
    h += `<tr><td>${esc(students()[sid].name)}</td><td>${esc(f.name)}</td><td>${esc(stName(f.station || ''))}</td><td>${esc(startOf(fid))}</td>
      <td class="num">${fmtMin(b && b.total)}</td><td>${esc(brk)}</td><td>${mk.m}${b && ((b.r && b.r.shinkansen) || (b.d && b.d.shinkansen)) ? ' 新幹線' : ''}${isStay(ev) ? ' 宿泊' : ''}</td></tr>`;
  }
  const used = new Set(sids.map(sid => A[sid] && A[sid].fid));
  const empty = facsOf(t).filter(fid => !used.has(fid));
  if (empty.length) h += `<tr><td colspan="7"><b>学生のいない施設：</b>${empty.map(fid => esc(S.facilities[fid].name)).join('、')}</td></tr>`;
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
