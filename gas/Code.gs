/**
 * 実習配置アプリ GAS（2026-10-21 作り直し）
 * 役目は Google Maps に聞いて返すだけ。何も保存しない。スプレッドシートに付けない単独の GAS。
 * 先生かどうかは、画面が送る Firebase の ID トークンで teachers/<uid> を読めるかで確かめる
 * （読めない＝先生でない・トークンが偽物や期限切れ）。合言葉・秘密の値は持たない。
 *
 * 公開：デプロイ → 新しいデプロイ → 種類「ウェブアプリ」・実行するユーザー「自分」・アクセス「全員」
 */
const DB_URL = 'https://zissyu-kyori-default-rtdb.asia-southeast1.firebasedatabase.app';
const MAX_JOBS = 10;   // 1回に受ける件数（6分の上限より十分小さく）

function doPost(e) {
  let req;
  try { req = JSON.parse(e.postData.contents); } catch (_) { return out_({ status: 'ERROR', message: '形が違う' }); }
  if (!verifyTeacher_(req.idToken)) return out_({ status: 'ERROR', code: 'AUTH', message: '先生として確認できない（ログインし直す）' });
  const jobs = (req.jobs || []).slice(0, MAX_JOBS);
  const fn = { transit: transit_, walk: walk_, car: car_, station: station_, geo: geo_, door: door_ }[req.action];
  if (!fn) return out_({ status: 'ERROR', message: '知らない操作' });
  const results = jobs.map(j => { try { return fn(j); } catch (err) { return { err: String(err.message || err).slice(0, 100) }; } });
  return out_({ status: 'OK', results: results });
}

function doGet() { return out_({ status: 'OK', message: '実習配置アプリの経路計算' }); }

function out_(o) { return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON); }

// ---- 先生かどうか ----
function verifyTeacher_(tok) {
  if (!tok || typeof tok !== 'string') return false;
  const parts = tok.split('.');
  if (parts.length !== 3) return false;
  let p;
  try {
    let b = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    while (b.length % 4) b += '=';
    p = JSON.parse(Utilities.newBlob(Utilities.base64Decode(b)).getDataAsString());
  } catch (_) { return false; }
  const uid = p.user_id || p.sub;
  if (!uid || !/^[A-Za-z0-9]{10,64}$/.test(uid)) return false;
  // 同じトークンは10分まで覚えておく（Firebase への問い合わせを減らす）
  const cache = CacheService.getScriptCache();
  const key = 't' + Utilities.base64EncodeWebSafe(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, tok));
  if (cache.get(key) === uid) return true;
  const r = UrlFetchApp.fetch(DB_URL + '/teachers/' + uid + '.json?auth=' + encodeURIComponent(tok), { muteHttpExceptions: true });
  if (r.getResponseCode() !== 200 || r.getContentText() === 'null') return false;
  cache.put(key, uid, 600);
  return true;
}

// ---- 共通 ----
function place_(s) {
  s = String(s || '').trim();
  if (!s) throw new Error('空');
  return s + ', 日本';
}
function station_name_(s) { s = String(s || '').trim(); return /駅$/.test(s) ? s : s + '駅'; }
// 駅・バス停・電停の場所：緯度経度があればそれ（バス停は名前だと別の所に当たる）、無ければ「〇〇駅」
function stop_(name, loc) { return loc ? String(loc) : place_(station_name_(name)); }

// 次の水曜日（平日の朝の便で探す）
function weekday_(hhmm) {
  const d = new Date();
  d.setDate(d.getDate() + ((3 - d.getDay() + 7) % 7 || 7));
  const m = String(hhmm || '08:30').match(/(\d{1,2}):(\d{2})/);
  d.setHours(m ? +m[1] : 8, m ? +m[2] : 30, 0, 0);
  return d;
}

// ---- 学生の駅（バス停・電停は緯度経度）→施設の最寄り。job = {from, fromLoc?, to, toLoc?, arrive:'08:10'} ----
// 地図に描く線（Google の折れ線そのまま・区間ごと）。dropHead＝最初に乗るまでの歩きを捨てる（家の場所を残さない）
function segs_(steps, dropHead) {
  const out = []; let seen = false;
  steps.forEach(st => {
    const T = st.travel_mode === 'TRANSIT';
    if (T) seen = true;
    if (dropHead && !seen) return;
    const td = st.transit_details || {}, ln = td.line || {};
    out.push({ m: T ? 'T' : 'W', t: T ? (ln.short_name || ln.name || '') : '', c: T ? (ln.color || '') : '',
      a: T && td.departure_stop ? td.departure_stop.name : '', b: T && td.arrival_stop ? td.arrival_stop.name : '',
      p: st.polyline ? st.polyline.points : '' });
  });
  return out;
}

function transit_(j) {
  const from = station_name_(j.from), to = station_name_(j.to);
  if (from === to && !j.fromLoc && !j.toLoc) return { ride: 0, transfers: 0, shinkansen: false, lines: '同じ駅', dep: '', arr: '' };
  const res = Maps.newDirectionFinder()
    .setOrigin(stop_(j.from, j.fromLoc)).setDestination(stop_(j.to, j.toLoc))
    .setMode(Maps.DirectionFinder.Mode.TRANSIT)
    .setArrive(weekday_(j.arrive)).setLanguage('ja').getDirections();
  if (!res.routes || !res.routes.length) return { err: '経路なし' };
  const leg = res.routes[0].legs[0];
  let transits = 0, shin = false, firstWalk = 0, seenTransit = false;
  const lines = [];
  leg.steps.forEach(st => {
    if (st.travel_mode === 'TRANSIT') {
      seenTransit = true; transits++;
      const td = st.transit_details, ln = td.line || {};
      const nm = ln.short_name || ln.name || '';
      if ((ln.vehicle && ln.vehicle.type === 'HIGH_SPEED_TRAIN') || /新幹線/.test(nm)) shin = true;
      lines.push(nm + '（' + td.departure_stop.name + '→' + td.arrival_stop.name + '）');
    } else if (!seenTransit && st.travel_mode === 'WALKING') {
      firstWalk += Math.round(st.duration.value / 60);
    }
  });
  if (!transits) return { err: '電車の経路なし（徒歩' + Math.round(leg.duration.value / 60) + '分）', walkOnly: Math.round(leg.duration.value / 60) };
  return {
    ride: Math.round(leg.duration.value / 60),   // 出発駅を出てから着く駅まで（乗換の待ちを含む）
    transfers: transits - 1, shinkansen: shin, lines: lines.join(' / '),
    dep: leg.departure_time ? leg.departure_time.text : '', arr: leg.arrival_time ? leg.arrival_time.text : '',
    fromAddr: leg.start_address, toAddr: leg.end_address, extraWalk: firstWalk, poly: segs_(leg.steps, false)
  };
}

// ---- 施設の最寄り→施設（徒歩）。job = {station, loc?, address} ----
function walk_(j) {
  const res = Maps.newDirectionFinder()
    .setOrigin(stop_(j.station, j.loc)).setDestination(place_(j.address))
    .setMode(Maps.DirectionFinder.Mode.WALKING).setLanguage('ja').getDirections();
  if (!res.routes || !res.routes.length) return { err: '徒歩の経路なし' };
  const leg = res.routes[0].legs[0];
  const m = leg.distance.value;
  return { walk: Math.round(leg.duration.value / 60), meters: m, bike: Math.max(1, Math.ceil(m / 250)), poly: res.routes[0].overview_polyline.points };  // 自転車は時速15kmの目安
}

// ---- 車（住所はこの呼び出しの中だけ・保存しない）。job = {from, to, arrive} ----
function car_(j) {
  const res = Maps.newDirectionFinder()
    .setOrigin(place_(j.from)).setDestination(place_(j.to))
    .setMode(Maps.DirectionFinder.Mode.DRIVING).setArrive(weekday_(j.arrive)).setLanguage('ja').getDirections();
  if (!res.routes || !res.routes.length) return { err: '車の経路なし' };
  return { car: Math.round(res.routes[0].legs[0].duration.value / 60) };
}

// ---- 住所・停留所の名前→緯度経度。job = {address} ----
function geo_(j) {
  const g = Maps.newGeocoder().setLanguage('ja').setRegion('jp').geocode(place_(j.address));
  if (!g.results || !g.results.length) return { err: '住所が地図で見つからない' };
  const r = g.results[0];
  return { lat: r.geometry.location.lat, lng: r.geometry.location.lng, addr: String(r.formatted_address || '').replace(/^日本、\s*/, '') };
}

// ---- 家の住所→施設の住所（電車・バス・歩き）。job = {from, to, arrive}。住所は返さない・残さない ----
function door_(j) {
  const res = Maps.newDirectionFinder()
    .setOrigin(place_(j.from)).setDestination(place_(j.to))
    .setMode(Maps.DirectionFinder.Mode.TRANSIT)
    .setArrive(weekday_(j.arrive)).setLanguage('ja').getDirections();
  if (!res.routes || !res.routes.length) return { err: '経路なし' };
  const leg = res.routes[0].legs[0];
  let transits = 0, shin = false, walk1 = 0, walk2 = 0;
  const lines = [];
  leg.steps.forEach(st => {
    if (st.travel_mode === 'TRANSIT') {
      transits++; walk2 = 0;
      const td = st.transit_details, ln = td.line || {}, nm = ln.short_name || ln.name || '';
      if ((ln.vehicle && ln.vehicle.type === 'HIGH_SPEED_TRAIN') || /新幹線/.test(nm)) shin = true;
      lines.push(nm + '（' + td.departure_stop.name + '→' + td.arrival_stop.name + '）');
    } else if (st.travel_mode === 'WALKING') {
      const m = Math.round(st.duration.value / 60);
      if (!transits) walk1 += m; else walk2 += m;
    }
  });
  return {
    min: Math.round(leg.duration.value / 60),   // 家を出てから施設に着くまで（乗換の待ちを含む）
    transfers: Math.max(0, transits - 1), shinkansen: shin, lines: lines.join(' / '), walk1: walk1, walk2: transits ? walk2 : 0,
    dep: leg.departure_time ? leg.departure_time.text : '', arr: leg.arrival_time ? leg.arrival_time.text : '',
    poly: segs_(leg.steps, true)   // 家から最初に乗る所までの歩きは捨てる
  };
}

// ---- 施設の最寄りの駅・バス停・電停の下書き。job = {address, arrive, here?, cands?} ----
// 施設の住所から歩いて一番近い公共交通（駅・バス停・電停）を返す（先生が直す前提の下書き）
// 候補＝画面が OpenStreetMap から拾った近くの停留所（cands・無くてもよい）＋Google の経路で施設のそばで乗り降りする所。徒歩の時間で一番短い所を選ぶ
// OpenStreetMap（Overpass）は返事が来ないことがある＝GAS からは呼ばない（待つと6分を超えて固まる・2026-10-21）
function station_(j) {
  const here = j.here || geo_(j);
  if (here.err) return here;
  const cands = (j.cands || []).slice(0, 4);
  routeStops_(j).forEach(c => { if (!cands.some(x => x.name === c.name)) cands.push(c); });
  if (!cands.length) return { err: '近くに駅・バス停が見つからない' };
  let best = null;
  cands.forEach(c => {
    const res = Maps.newDirectionFinder()
      .setOrigin(here.lat + ',' + here.lng).setDestination(c.lat + ',' + c.lng)
      .setMode(Maps.DirectionFinder.Mode.WALKING).setLanguage('ja').getDirections();
    if (!res.routes || !res.routes.length) return;
    const leg = res.routes[0].legs[0], walk = Math.round(leg.duration.value / 60), m = leg.distance.value;
    if (!best || walk < best.walk) best = { station: c.name.replace(/駅$/, ''), kind: c.kind, loc: c.lat + ',' + c.lng, walk: walk, meters: m, bike: Math.max(1, Math.ceil(m / 250)) };
  });
  return best || { err: '徒歩の経路が出ない' };
}

// Google の経路で施設のそばの停留所（Google は出発・到着の近くの停留所を選ぶ＝向きを変えて何本か聞く）
// 施設→岡山駅・倉敷駅・東岡山駅で最初に乗る所、岡山駅→施設で最後に降りる所
function routeStops_(j) {
  const out = [];
  [['施設', '岡山駅'], ['施設', '倉敷駅'], ['施設', '東岡山駅'], ['岡山駅', '施設']].forEach(pair => {
    try {
      const fromFac = pair[0] === '施設';
      const res = Maps.newDirectionFinder()
        .setOrigin(place_(fromFac ? j.address : pair[0])).setDestination(place_(fromFac ? pair[1] : j.address))
        .setMode(Maps.DirectionFinder.Mode.TRANSIT)
        .setArrive(weekday_(j.arrive || '08:10')).setLanguage('ja').getDirections();
      if (!res.routes || !res.routes.length) return;
      const tds = res.routes[0].legs[0].steps.filter(st => st.travel_mode === 'TRANSIT' && st.transit_details).map(st => st.transit_details);
      if (!tds.length) return;
      const td = fromFac ? tds[0] : tds[tds.length - 1], stop = fromFac ? td.departure_stop : td.arrival_stop;
      const v = ((td.line || {}).vehicle || {}).type || '';
      const kind = /BUS/.test(v) ? 'バス' : /TRAM|LIGHT_RAIL/.test(v) ? '路面電車' : /SUBWAY|METRO/.test(v) ? '地下鉄' : '電車';
      out.push({ name: stop.name, kind: kind, lat: stop.location.lat, lng: stop.location.lng });
    } catch (_) {}
  });
  return out;
}
