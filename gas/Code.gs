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
  const fn = { transit: transit_, walk: walk_, car: car_, station: station_ }[req.action];
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

// ---- 駅→施設の最寄り（電車・バス・路面電車）。job = {from, to, toLoc?, arrive:'08:10'} ----
function transit_(j) {
  const from = station_name_(j.from), to = station_name_(j.to);
  if (from === to) return { ride: 0, transfers: 0, shinkansen: false, lines: '同じ駅', dep: '', arr: '' };
  const res = Maps.newDirectionFinder()
    .setOrigin(place_(from)).setDestination(stop_(j.to, j.toLoc))
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
    fromAddr: leg.start_address, toAddr: leg.end_address, extraWalk: firstWalk
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
  return { walk: Math.round(leg.duration.value / 60), meters: m, bike: Math.max(1, Math.ceil(m / 250)) };  // 自転車は時速15kmの目安
}

// ---- 車（住所はこの呼び出しの中だけ・保存しない）。job = {from, to, arrive} ----
function car_(j) {
  const res = Maps.newDirectionFinder()
    .setOrigin(place_(j.from)).setDestination(place_(j.to))
    .setMode(Maps.DirectionFinder.Mode.DRIVING).setArrive(weekday_(j.arrive)).setLanguage('ja').getDirections();
  if (!res.routes || !res.routes.length) return { err: '車の経路なし' };
  return { car: Math.round(res.routes[0].legs[0].duration.value / 60) };
}

// ---- 施設の最寄りの駅・バス停・電停の下書き。job = {address, arrive} ----
// 岡山駅から施設へ公共交通（電車・バス・路面電車）で行く経路をとり、最後に降りる所を返す（先生が直す前提の下書き）
function station_(j) {
  const res = Maps.newDirectionFinder()
    .setOrigin(place_('岡山駅')).setDestination(place_(j.address))
    .setMode(Maps.DirectionFinder.Mode.TRANSIT)
    .setArrive(weekday_(j.arrive || '08:10')).setLanguage('ja').getDirections();
  if (!res.routes || !res.routes.length) return { err: '岡山駅からの経路が見つからない' };
  const steps = res.routes[0].legs[0].steps;
  let last = -1;
  steps.forEach((st, i) => { if (st.travel_mode === 'TRANSIT' && st.transit_details) last = i; });
  if (last < 0) {   // 乗り物を使わない経路しか出ない＝岡山駅から歩く
    return { station: '岡山', kind: '電車', walk: Math.round(res.routes[0].legs[0].duration.value / 60), walkOnly: true };
  }
  const td = steps[last].transit_details, stop = td.arrival_stop;
  const v = ((td.line || {}).vehicle || {}).type || '';
  const kind = /BUS/.test(v) ? 'バス' : /TRAM|LIGHT_RAIL/.test(v) ? '路面電車' : '電車';
  let walk = 0;
  for (let i = last + 1; i < steps.length; i++) walk += Math.round(steps[i].duration.value / 60);
  return { station: stop.name.replace(/駅$/, ''), kind: kind, loc: stop.location.lat + ',' + stop.location.lng, walk: walk };
}
