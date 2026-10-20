/**
 * Fleet Daily Check — Cloudflare Worker สำหรับเก็บข้อมูลและรูปใน R2 (bucket: cartaxi)
 *
 * โครงสร้างไฟล์ใน R2
 *   data/cars.json                          รายการรถทั้งหมด
 *   data/repairs/<id>.json                  งานซ่อม 1 ไฟล์ต่อ 1 งาน
 *   data/records/<YYYY-MM>/<date>_<carId>.json      เลขไมล์/น้ำมัน ขาไป
 *   data/records/<YYYY-MM>/<date>_<carId>_in.json   เลขไมล์/น้ำมัน ขากลับ
 *   photos/<YYYY-MM>/<ชื่อไฟล์>.jpg          รูปหน้าปัด / บิล / รูปอาการซ่อม
 *
 * สิทธิ์ (ส่งรหัสใน header X-App-Key)
 *   (ไม่ใส่รหัส) = คนขับ   : ทำได้ทุกอย่าง — อ่านข้อมูล, ส่งเลขไมล์, เพิ่ม/แก้/ลบรถ, แจ้งซ่อม/เปลี่ยนสถานะซ่อม, อัปโหลดรูป
 *   APP_KEY   = รหัสคนขับ  : สิทธิ์เดียวกับคนขับ (ใช้เมื่อตั้ง REQUIRE_APP_KEY = "true")
 *   ADMIN_KEY = รหัสแอดมิน : สิทธิ์เท่าคนขับ (ไม่จำเป็นต้องใช้แล้ว)
 * รูปเปิดดูได้ผ่าน /photos/... (ชื่อไฟล์สุ่ม เดาไม่ได้) เพื่อให้แท็ก <img> แสดงได้
 */

const MAX_JSON = 64 * 1024;          // 64 KB ต่อรายการ
const MAX_PHOTO = 3 * 1024 * 1024;   // 3 MB ต่อรูป
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MONTH_RE = /^\d{4}-\d{2}$/;
const PHOTO_RE = /^\d{4}-\d{2}\/[a-z0-9_-]{8,80}\.jpg$/;

function cors(env) {
  return {
    'Access-Control-Allow-Origin': env.ALLOW_ORIGIN || '*',
    'Access-Control-Allow-Methods': 'GET,PUT,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type,X-App-Key',
    'Access-Control-Max-Age': '86400',
  };
}
function json(env, data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...cors(env) },
  });
}
function fail(env, status, msg) { return json(env, { ok: false, error: msg }, status); }

function roleOf(req, env) {
  const k = req.headers.get('X-App-Key') || '';
  if (env.ADMIN_KEY && k === env.ADMIN_KEY) return 'admin';
  if (env.APP_KEY && k === env.APP_KEY) return 'driver';
  // ไม่ใส่รหัส = ใช้งานแบบคนขับได้เลย (ปิดได้โดยตั้งตัวแปร REQUIRE_APP_KEY = "true")
  if (!k && env.REQUIRE_APP_KEY !== 'true') return 'driver';
  return null;
}

async function readJson(req, env) {
  const len = Number(req.headers.get('Content-Length') || 0);
  if (len > MAX_JSON) throw new Error('ข้อมูลใหญ่เกินไป');
  const text = await req.text();
  if (text.length > MAX_JSON) throw new Error('ข้อมูลใหญ่เกินไป');
  return JSON.parse(text);
}

async function getJson(env, key, fallback) {
  const o = await env.BUCKET.get(key);
  if (!o) return fallback;
  try { return await o.json(); } catch { return fallback; }
}
async function putJson(env, key, data) {
  await env.BUCKET.put(key, JSON.stringify(data), { httpMetadata: { contentType: 'application/json' } });
}

/** อ่านทุกไฟล์ JSON ใต้ prefix (มีแบ่งหน้า) */
async function readAll(env, prefix) {
  const keys = [];
  let cursor;
  do {
    const page = await env.BUCKET.list({ prefix, cursor, limit: 1000 });
    page.objects.forEach((o) => keys.push(o.key));
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  const out = [];
  for (let i = 0; i < keys.length; i += 50) {
    const chunk = await Promise.all(keys.slice(i, i + 50).map((k) => getJson(env, k, null)));
    chunk.forEach((x) => { if (x) out.push(x); });
  }
  return out;
}

/* ===================== แจ้งเตือนเข้า LINE (Messaging API) =====================
 * ตั้ง Secret ใน Cloudflare (Workers → cartaxi-api → Settings → Variables and Secrets):
 *   LINE_TOKEN          = Channel access token (long-lived) ของ LINE Official Account
 *   LINE_TO             = (ไม่บังคับ) groupId / userId ที่จะส่งไป คั่นด้วย , ได้หลายที่
 *   LINE_SECRET         = (ไม่บังคับ) Channel secret ใช้ตรวจลายเซ็น webhook
 * ถ้าไม่ตั้ง LINE_TO: ตั้ง Webhook URL ของ OA เป็น https://<worker>/line/webhook
 *   แล้วเชิญบอทเข้ากลุ่ม ระบบจะจำ groupId ของกลุ่มล่าสุดให้เอง (data/line/target.json)
 */
const TH_MON = ['ม.ค.', 'ก.พ.', 'มี.ค.', 'เม.ย.', 'พ.ค.', 'มิ.ย.', 'ก.ค.', 'ส.ค.', 'ก.ย.', 'ต.ค.', 'พ.ย.', 'ธ.ค.'];
function thDay(ymd) { const [y, m, d] = String(ymd || '').split('-').map(Number); return y ? d + ' ' + TH_MON[m - 1] + ' ' + String((y + 543) % 100).padStart(2, '0') : '—'; }
function nf(n) { return n == null || isNaN(n) ? '—' : Number(n).toLocaleString('en-US'); }
function fuelPct(r) { if (!r || r.fuel == null) return null; return Math.round(r.fuel / (r.fs || 8) * 100); }
function locOf(r) {
  if (r.dest) return String(r.dest).trim();
  const s = String(r.route || '').split(/→|->|>|,/).map((x) => x.trim()).filter(Boolean);
  return s.length ? s[s.length - 1] : '';
}
function httpsUrl(u) { return /^https:\/\/[^\s"']+$/.test(String(u || '')) ? String(u) : null; }

function row(icon, label, value, color) {
  return {
    type: 'box', layout: 'horizontal', spacing: 'md', contents: [
      { type: 'text', text: icon + ' ' + label, size: 'sm', color: '#6B7280', flex: 4 },
      { type: 'text', text: String(value == null || value === '' ? '—' : value), size: 'sm', weight: 'bold', color: color || '#111827', flex: 6, align: 'end', wrap: true },
    ],
  };
}
function card(color, kicker, title, rows, photo, appUrl) {
  const b = {
    type: 'bubble',
    header: { type: 'box', layout: 'vertical', backgroundColor: color, paddingAll: '18px', contents: [
      { type: 'text', text: kicker, size: 'sm', color: '#FFFFFFCC', weight: 'bold' },
      { type: 'text', text: title, size: 'xl', color: '#FFFFFF', weight: 'bold', wrap: true, margin: 'sm' },
    ] },
    body: { type: 'box', layout: 'vertical', spacing: 'md', paddingAll: '18px', contents: rows },
  };
  if (photo) b.hero = { type: 'image', url: photo, size: 'full', aspectRatio: '4:3', aspectMode: 'cover', action: { type: 'uri', uri: photo } };
  if (appUrl) b.footer = { type: 'box', layout: 'vertical', contents: [
    { type: 'button', style: 'link', height: 'sm', action: { type: 'uri', label: 'เปิดแอป Fleet Daily Check', uri: appUrl } },
  ] };
  return b;
}

async function lineTargets(env) {
  const fixed = String(env.LINE_TO || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (fixed.length) return fixed;
  const saved = await getJson(env, 'data/line/target.json', null);
  return saved && saved.id ? [saved.id] : [];
}
async function linePush(env, alt, bubble) {
  if (!env.LINE_TOKEN) return { ok: false, error: 'ยังไม่ได้ตั้ง LINE_TOKEN' };
  const to = await lineTargets(env);
  if (!to.length) return { ok: false, error: 'ยังไม่รู้ว่าจะส่งไปกลุ่มไหน (ตั้ง LINE_TO หรือเชิญบอทเข้ากลุ่ม)' };
  const out = [];
  for (const id of to) {
    const res = await fetch('https://api.line.me/v2/bot/message/push', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + env.LINE_TOKEN },
      body: JSON.stringify({ to: id, messages: [{ type: 'flex', altText: alt.slice(0, 380), contents: bubble }] }),
    });
    out.push({ to: id, status: res.status, body: res.ok ? '' : (await res.text()).slice(0, 300) });
  }
  return { ok: out.every((x) => x.status === 200), result: out };
}
async function carName(env, carId) {
  const cars = await getJson(env, 'data/cars.json', []);
  const c = (cars || []).find((x) => x && x.id === carId);
  return 'รถ ' + (c ? (c.plate || carId) : carId);
}

async function notifyRecord(env, r, isEdit, origin) {
  const plate = await carName(env, r.carId);
  const isIn = r.trip === 'in';
  const fp = fuelPct(r), loc = locOf(r);
  const rows = [
    row('👤', 'ผู้ขับ', r.driver),
    row('🕒', 'เวลา', thDay(r.date) + ' · ' + (r.time || '') + ' น.'),
    row('🚗', 'เลขไมล์', nf(r.odo) + ' กม.'),
  ];
  if (r.km != null) rows.push(row('📏', 'วิ่งจากครั้งก่อน', (r.km >= 0 ? '+' : '') + nf(r.km) + ' กม.', r.km < 0 ? '#C8372D' : '#1F8A4C'));
  if (r.route) rows.push(row('🛣️', 'ไปไหนมา', r.route));
  if (loc) rows.push(row('📍', 'รถอยู่ที่', loc));
  rows.push(row('⛽', 'น้ำมัน', fp == null ? '—' : fp + '%', fp != null && fp <= 25 ? '#C8372D' : null));
  if (r.liters || r.cost) rows.push(row('🧾', 'เติมน้ำมัน', (r.liters ? r.liters + ' ล.' : '') + (r.liters && r.cost ? ' · ' : '') + (r.cost ? nf(r.cost) + ' บาท' : '')));
  if (r.note) rows.push(row('📝', 'หมายเหตุ', r.note));
  const title = (isIn ? '🔴 ขากลับ' : '🟢 ขาไป') + ' · ' + plate + (isEdit ? ' (แก้ไข)' : '');
  const alt = title + ' · ไมล์ ' + nf(r.odo) + (loc ? ' · อยู่' + loc : '') + ' · น้ำมัน ' + (fp == null ? '—' : fp + '%');
  return linePush(env, alt, card(isIn ? '#C8372D' : '#1F8A4C', 'FLEET DAILY CHECK · 2PS', title, rows, httpsUrl(r.photoOdo), origin + '/'));
}

const REPAIR_ST = { reported: 'แจ้งซ่อม · ยังใช้ได้', waiting: 'รอซ่อม · หยุดใช้', done: 'ซ่อมเสร็จแล้ว' };
async function notifyRepair(env, t, origin) {
  const plate = await carName(env, t.carId);
  const at = t.at ? new Date(t.at) : new Date();
  const bkk = new Date(at.getTime() + 7 * 3600e3);
  const when = thDay(bkk.toISOString().slice(0, 10)) + ' · ' + bkk.toISOString().slice(11, 16) + ' น.';
  const rows = [
    row('⚠️', 'อาการ', t.issue, '#A12A21'),
    row('👤', 'แจ้งโดย', t.by),
    row('🕒', 'เวลา', when),
    row('🔧', 'สถานะ', REPAIR_ST[t.status] || t.status),
  ];
  const title = '🔧 แจ้งซ่อม · ' + plate;
  return linePush(env, title + ' · ' + String(t.issue || ''), card('#E8740C', 'FLEET DAILY CHECK · 2PS', title, rows, httpsUrl(t.photo), origin + '/'));
}

async function hmacOk(env, body, sig) {
  if (!env.LINE_SECRET) return true;
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(env.LINE_SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body));
  const b64 = btoa(String.fromCharCode(...new Uint8Array(mac)));
  return b64 === sig;
}

/* ===================== บอทในกลุ่ม LINE: อ่านเลขไมล์/น้ำมันจากรูป =====================
 * คนขับส่งรูปหน้าปัด + พิมพ์เบอร์รถ (เช่น "05คับ") ในกลุ่ม → ระบบอ่านรูปด้วย Workers AI
 * บันทึกเป็นขาไป/ขากลับ แล้ว "ตอบกลับ" (reply ฟรี ไม่นับโควตา) เป็นการ์ด
 * ต้องตั้ง Secret: LINE_TOKEN, LINE_SECRET และผูก Workers AI (binding "AI" ใน wrangler.toml)
 */
const VISION_MODEL = '@cf/meta/llama-3.2-11b-vision-instruct';
const PAIR_MS = 15 * 60 * 1000;      // จับคู่รูปกับเบอร์รถที่คนเดียวกันส่งภายใน 15 นาที
const MAX_KM_DAY = 800;

function bkkNow() { const d = new Date(Date.now() + 7 * 3600e3); return { date: d.toISOString().slice(0, 10), time: d.toISOString().slice(11, 16) }; }
function rid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }

async function lineApi(env, path, body) {
  return fetch('https://api.line.me' + path, {
    method: body ? 'POST' : 'GET',
    headers: { Authorization: 'Bearer ' + env.LINE_TOKEN, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
}
async function lineReply(env, token, messages) {
  if (!token) return;
  const r = await lineApi(env, '/v2/bot/message/reply', { replyToken: token, messages: messages.slice(0, 5) });
  if (!r.ok) await putJson(env, 'data/line/error.json', { at: new Date().toISOString(), error: 'reply ' + r.status + ' ' + (await r.text()).slice(0, 400) }).catch(() => {});
}
function textMsg(t) { return { type: 'text', text: String(t).slice(0, 4900) }; }
async function displayName(env, src) {
  try {
    const p = src.type === 'group' ? '/v2/bot/group/' + src.groupId + '/member/' + src.userId
      : src.type === 'room' ? '/v2/bot/room/' + src.roomId + '/member/' + src.userId : '/v2/bot/profile/' + src.userId;
    const r = await lineApi(env, p); if (!r.ok) return '';
    const j = await r.json(); return String(j.displayName || '').trim();
  } catch { return ''; }
}

/* เบอร์รถ = ตัวเลขชุดแรก (1–3 หลัก) ที่ตรงกับทะเบียนในรายการรถ · เลขไมล์ = ตัวเลข 4–7 หลักที่ตามมา (ถ้าพิมพ์มา) */
function parseCarText(text, cars) {
  const nums = String(text || '').replace(/,/g, '').match(/\d+/g) || [];
  if (!nums.length) return null;
  const want = parseInt(nums[0], 10);
  if (nums[0].length > 3) return null;
  const car = (cars || []).find((c) => {
    const d = String(c.plate || '').replace(/\D/g, '');
    return d && parseInt(d, 10) === want && String(c.plate).replace(/[\s\d]/g, '').length <= 3;
  }) || (cars || []).find((c) => String(c.id) === nums[0]);
  if (!car) return null;
  const odoTxt = nums.slice(1).find((n) => n.length >= 4 && n.length <= 7);
  return { car, odo: odoTxt ? parseInt(odoTxt, 10) : null };
}

async function carRecords(env, carId) {
  const now = new Date(Date.now() + 7 * 3600e3);
  const months = [now.toISOString().slice(0, 7)];
  const prev = new Date(now); prev.setUTCDate(1); prev.setUTCMonth(prev.getUTCMonth() - 1); months.push(prev.toISOString().slice(0, 7));
  const out = [];
  for (const m of months) {
    let cursor;
    do {
      const page = await env.BUCKET.list({ prefix: 'data/records/' + m + '/', cursor, limit: 1000 });
      for (const o of page.objects) {
        if (o.key.endsWith('_' + carId + '.json') || o.key.endsWith('_' + carId + '_in.json')) {
          const r = await getJson(env, o.key, null); if (r && r.carId === carId) out.push(r);
        }
      }
      cursor = page.truncated ? page.cursor : undefined;
    } while (cursor);
  }
  const ord = (r) => r.date + (r.trip === 'in' ? 'b' : 'a');
  return out.sort((a, b) => (ord(a) < ord(b) ? -1 : ord(a) > ord(b) ? 1 : 0));
}

function b64(bytes) {
  let bin = ''; const CH = 0x8000;
  for (let i = 0; i < bytes.length; i += CH) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CH));
  return btoa(bin);
}
const DASH_PROMPT =
  'You are reading a photo of a car instrument cluster (Thai pickup trucks / vans).\n' +
  'Task 1 - ODOMETER: the total distance in km. On digital clusters it is labelled ODO (ignore TRIP A/B, range, time, temperature). ' +
  'On analog clusters it is the 6-digit rolling counter inside the speedometer (ignore the smaller trip counter). Return the full integer.\n' +
  'Task 2 - FUEL LEVEL as percent: find the fuel gauge (fuel-pump icon, letters E and F). ' +
  'Analog needle: E=0, 1/4=25, 1/2=50, 3/4=75, F=100, estimate where the needle points. ' +
  'Digital bars: lit bars / total bars x 100. Round to the nearest 10. ' +
  'Return null only if no fuel gauge is visible at all.\n' +
  'Answer with ONLY compact JSON and nothing else: {"odo":<integer or null>,"fuel":<integer 0-100 or null>}';
async function aiRun(env, model, input) {
  try { return await env.AI.run(model, input); }
  catch (e) {
    if (/agree/i.test(String(e && e.message))) { await env.AI.run(model, { prompt: 'agree' }); return env.AI.run(model, input); }
    throw e;
  }
}
function parseDash(out) {
  let v = out && typeof out === 'object' && 'response' in out ? out.response : out;
  if (v && typeof v === 'object' && v.choices) v = v.choices[0] && v.choices[0].message && v.choices[0].message.content;
  let j = {}, txt;
  if (v && typeof v === 'object') { j = v; txt = JSON.stringify(v); }   // บางโมเดลส่ง JSON เป็นอ็อบเจ็กต์มาเลย
  else {
    txt = String(v == null ? '' : v);
    const m = txt.match(/\{[^{}]*\}/);
    try { j = m ? JSON.parse(m[0]) : {}; } catch {}
  }
  const odo = Number.isFinite(Number(j.odo)) && Number(j.odo) > 0 ? Math.round(Number(j.odo)) : null;
  let fuel = j.fuel == null || j.fuel === '' || !Number.isFinite(Number(j.fuel)) ? null : Math.max(0, Math.min(100, Math.round(Number(j.fuel) / 10) * 10));
  return { odo, fuel, raw: txt.slice(0, 160) };
}
/* อ่านด้วยโมเดลที่เก่งกว่าก่อน (Llama 4 Scout) ถ้าไม่ได้ค่อยใช้ Llama 3.2 Vision แล้วเอาค่าที่อ่านได้มารวมกัน */
async function readDash(env, bytes) {
  if (!env.AI) return { odo: null, fuel: null, err: 'ยังไม่ได้ผูก Workers AI' };
  const url = 'data:image/jpeg;base64,' + b64(bytes);
  const tries = [
    ['@cf/meta/llama-4-scout-17b-16e-instruct', { messages: [{ role: 'user', content: [{ type: 'text', text: DASH_PROMPT }, { type: 'image_url', image_url: { url } }] }], max_tokens: 60, temperature: 0 }],
    [VISION_MODEL, { prompt: DASH_PROMPT, image: [...bytes], max_tokens: 60, temperature: 0 }],
  ];
  const res = { odo: null, fuel: null, log: [] };
  for (const [model, input] of tries) {
    if (res.odo != null && res.fuel != null) break;
    try {
      const r = parseDash(await aiRun(env, model, input));
      res.log.push(model.split('/').pop() + ': ' + r.raw);
      if (res.odo == null && r.odo != null) res.odo = r.odo;
      if (res.fuel == null && r.fuel != null) res.fuel = r.fuel;
    } catch (e) { res.log.push(model.split('/').pop() + ' ERR ' + String(e && e.message || e).slice(0, 120)); }
  }
  await putJson(env, 'data/line/ocr.json', { at: new Date().toISOString(), odo: res.odo, fuel: res.fuel, log: res.log }).catch(() => {});
  return res;
}

async function savePhoto(env, bytes) {
  if (!(bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff)) return null;
  const now = bkkNow();
  const name = now.date.slice(0, 7) + '/' + (rid() + rid()).toLowerCase().replace(/[^a-z0-9]/g, '') + '.jpg';
  await env.BUCKET.put('photos/' + name, bytes, { httpMetadata: { contentType: 'image/jpeg' } });
  return name;
}

/* รวมรูป + เบอร์รถ แล้วบันทึก */
async function tryComplete(env, pend, replyToken, origin) {
  if (!pend.carId || !pend.photo) return false;
  const cars = await getJson(env, 'data/cars.json', []);
  const car = (cars || []).find((c) => c.id === pend.carId);
  if (!car) return false;
  const recs = await carRecords(env, car.id);
  const now = bkkNow();
  const todays = recs.filter((r) => r.date === now.date);
  const trip = todays.some((r) => r.trip !== 'in') ? 'in' : 'out';
  const prev = recs.filter((r) => (r.date + (r.trip === 'in' ? 'b' : 'a')) < (now.date + (trip === 'in' ? 'b' : 'a'))).pop() || null;
  const odo = pend.typedOdo || pend.ocr.odo;
  const plate = 'รถ ' + (car.plate || car.id);
  const bad = !odo ? 'อ่านเลขไมล์จากรูปไม่ได้'
    : prev && odo < prev.odo ? 'เลขไมล์ที่อ่านได้ ' + nf(odo) + ' น้อยกว่าครั้งก่อน (' + nf(prev.odo) + ')'
    : prev && odo - prev.odo > MAX_KM_DAY ? 'เลขไมล์ที่อ่านได้ ' + nf(odo) + ' มากกว่าครั้งก่อนเกิน ' + MAX_KM_DAY + ' กม.'
    : '';
  if (bad && !pend.typedOdo) {
    pend.waitOdo = true; await putJson(env, 'data/line/pending/' + pend.userId + '.json', pend);
    await lineReply(env, replyToken, [textMsg('⚠️ ' + plate + ': ' + bad + '\nกรุณาพิมพ์เบอร์รถตามด้วยเลขไมล์ เช่น  ' + String(car.plate).replace(/\D/g, '') + ' ' + (prev ? prev.odo + 50 : 123456))]);
    return true;
  }
  if (bad && pend.typedOdo && prev && odo < prev.odo) {
    await lineReply(env, replyToken, [textMsg('⚠️ ' + plate + ': เลขไมล์ ' + nf(odo) + ' น้อยกว่าครั้งก่อน (' + nf(prev.odo) + ') ยังไม่บันทึก กรุณาตรวจแล้วพิมพ์ใหม่')]);
    return true;
  }
  const fuel10 = pend.ocr.fuel == null ? null : Math.round(pend.ocr.fuel / 10);
  const r = {
    id: rid(), date: now.date, trip, time: now.time, carId: car.id, driver: pend.name || 'คนขับ',
    odo, fuel: fuel10, fs: 10, km: prev ? odo - prev.odo : null, liters: null, cost: null,
    photoOdo: pend.photo ? origin + '/photos/' + pend.photo : null, photoBill: null,
    note: pend.typedOdo ? 'เลขไมล์พิมพ์ใน LINE' : 'อ่านจากรูปใน LINE อัตโนมัติ', route: '', src: 'line',
  };
  const key = 'data/records/' + now.date.slice(0, 7) + '/' + now.date + '_' + car.id + (trip === 'in' ? '_in' : '') + '.json';
  await putJson(env, key, r);
  await env.BUCKET.delete('data/line/pending/' + pend.userId + '.json');
  const isIn = trip === 'in', fp = fuelPct(r);
  const rows = [
    row('👤', 'ผู้ขับ', r.driver),
    row('🕒', 'เวลา', thDay(r.date) + ' · ' + r.time + ' น.'),
    row('🚗', 'เลขไมล์', nf(r.odo) + ' กม.'),
  ];
  if (r.km != null) rows.push(row('📏', 'วิ่งจากครั้งก่อน', '+' + nf(r.km) + ' กม.', '#1F8A4C'));
  rows.push(row('⛽', 'น้ำมัน', fp == null ? 'อ่านไม่ได้ (แก้ในแอป)' : fp + '%', fp != null && fp <= 25 ? '#C8372D' : null));
  rows.push({ type: 'text', text: (pend.typedOdo ? 'เลขไมล์จากที่พิมพ์' : 'อ่านจากรูปอัตโนมัติ') + ' · ถ้าผิดกด "เปิดแอป" แล้วแก้ไขได้', size: 'xs', color: '#6B7280', wrap: true, margin: 'md' });
  const title = (isIn ? '🔴 ขากลับ' : '🟢 ขาไป') + ' · ' + plate;
  const bubble = card(isIn ? '#C8372D' : '#1F8A4C', 'FLEET DAILY CHECK · 2PS', title, rows, httpsUrl(r.photoOdo), origin + '/');
  const carNo = String(car.plate || car.id).replace(/\D/g, '') || String(car.plate);
  const qr = { items: [0, 10, 20, 30, 40, 50, 60, 70, 80, 90, 100].map((v) => ({ type: 'action', action: { type: 'message', label: v + '%', text: carNo + ' น้ำมัน ' + v + '%' } })) };
  const msgs = [{ type: 'flex', altText: title + ' · ไมล์ ' + nf(r.odo) + ' · น้ำมัน ' + (fp == null ? '—' : fp + '%'), contents: bubble }];
  msgs.push({ type: 'text', text: fp == null ? '⛽ อ่านระดับน้ำมันจากรูปไม่ได้ แตะเลือกด้านล่างได้เลย' : '⛽ ระดับน้ำมันไม่ตรง? แตะเลือกค่าที่ถูกด้านล่าง', quickReply: qr });
  await lineReply(env, replyToken, msgs);
  return true;
}

async function handleLineEvent(env, ev, origin) {
  const src = ev.source || {};
  if (src.type === 'group' && src.groupId) {
    const cur = await getJson(env, 'data/line/target.json', null);
    if (!cur || cur.id !== src.groupId) await putJson(env, 'data/line/target.json', { id: src.groupId, type: 'group', at: new Date().toISOString() });
  }
  if (ev.type !== 'message' || !src.userId || !env.LINE_TOKEN) return;
  const msg = ev.message || {};
  const pkey = 'data/line/pending/' + src.userId + '.json';
  let pend = await getJson(env, pkey, null);
  if (pend && Date.now() - pend.at > PAIR_MS) pend = null;

  if (msg.type === 'image') {
    const res = await fetch('https://api-data.line.me/v2/bot/message/' + msg.id + '/content', { headers: { Authorization: 'Bearer ' + env.LINE_TOKEN } });
    if (!res.ok) return;
    const bytes = new Uint8Array(await res.arrayBuffer());
    if (bytes.byteLength > 6 * 1024 * 1024) return;
    const early = pend && !pend.photo ? pend : null;   // พิมพ์เบอร์รถมาก่อนรูป
    await putJson(env, pkey, { userId: src.userId, name: (pend && pend.name) || '', at: Date.now(), processing: true, photo: null,
      ocr: { odo: null, fuel: null }, carId: early ? early.carId : null, typedOdo: early ? early.typedOdo : null });
    const [photo, ocr, name] = await Promise.all([savePhoto(env, bytes), readDash(env, bytes), displayName(env, src)]);
    const latest = (await getJson(env, pkey, null)) || {};   // เบอร์รถที่พิมพ์ตามมาระหว่างอ่านรูป
    pend = { userId: src.userId, name: name || latest.name || '', at: Date.now(), photo, ocr,
      carId: latest.carId || null, typedOdo: latest.typedOdo || null };
    await putJson(env, pkey, pend);
    await tryComplete(env, pend, ev.replyToken, origin);
    return;
  }
  if (msg.type === 'text') {
    const cars = await getJson(env, 'data/cars.json', []);
    const fm = String(msg.text || '').match(/น้ำมัน\s*(\d{1,3})\s*%?/);
    if (fm) {   // แก้ระดับน้ำมัน เช่น "02 น้ำมัน 60%" (มาจากปุ่มด่วน)
      const pc = parseCarText(msg.text.replace(fm[0], ''), cars);
      const v = Math.max(0, Math.min(100, Math.round(parseInt(fm[1], 10) / 10) * 10));
      if (!pc) return;
      const now = bkkNow(), base = 'data/records/' + now.date.slice(0, 7) + '/' + now.date + '_' + pc.car.id;
      let key = base + '_in.json', rec = await getJson(env, key, null);
      if (!rec) { key = base + '.json'; rec = await getJson(env, key, null); }
      if (!rec) { await lineReply(env, ev.replyToken, [textMsg('ยังไม่มีรายการวันนี้ของรถ ' + pc.car.plate + ' ส่งรูปหน้าปัด + เบอร์รถก่อนนะครับ')]); return; }
      rec.fuel = v / 10; rec.fs = 10;
      await putJson(env, key, rec);
      await lineReply(env, ev.replyToken, [textMsg('✅ รถ ' + pc.car.plate + ' (' + (rec.trip === 'in' ? 'ขากลับ' : 'ขาไป') + ') น้ำมัน ' + v + '% บันทึกแล้ว')]);
      return;
    }
    const p = parseCarText(msg.text, cars);
    if (!p) return;
    if (pend && pend.processing) {   // รูปกำลังถูกอ่านอยู่ ฝากเบอร์รถไว้ ให้ฝั่งรูปบันทึกและตอบกลับ
      pend.carId = p.car.id; if (p.odo) pend.typedOdo = p.odo;
      await putJson(env, pkey, pend); return;
    }
    if (!pend) {
      if (!p.odo) { await putJson(env, pkey, { userId: src.userId, name: await displayName(env, src), at: Date.now(), carId: p.car.id, typedOdo: null, photo: null, ocr: { odo: null, fuel: null } }); return; }
      pend = { userId: src.userId, name: await displayName(env, src), at: Date.now(), photo: null, ocr: { odo: null, fuel: null } };
    }
    pend.carId = p.car.id; if (p.odo) pend.typedOdo = p.odo; pend.at = Date.now();
    if (!pend.name) pend.name = await displayName(env, src);
    await putJson(env, pkey, pend);
    if (!pend.photo && p.odo) {
      await lineReply(env, ev.replyToken, [textMsg('รับเลขไมล์ รถ ' + p.car.plate + ' = ' + nf(p.odo) + ' แล้ว กรุณาส่งรูปหน้าปัดตามมาด้วย')]);
      return;
    }
    await tryComplete(env, pend, ev.replyToken, origin);
  }
}

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    const path = url.pathname.replace(/\/+$/, '') || '/';
    const m = req.method;

    if (m === 'OPTIONS') return new Response(null, { status: 204, headers: cors(env) });

    try {
      // ---------- รูป (อ่านได้โดยไม่ต้องใช้รหัส) ----------
      if (m === 'GET' && path.startsWith('/photos/')) {
        const name = decodeURIComponent(path.slice('/photos/'.length));
        if (!PHOTO_RE.test(name)) return fail(env, 404, 'ไม่พบรูป');
        const o = await env.BUCKET.get('photos/' + name);
        if (!o) return fail(env, 404, 'ไม่พบรูป');
        return new Response(o.body, {
          headers: { 'Content-Type': 'image/jpeg', 'Cache-Control': 'public, max-age=31536000, immutable', ...cors(env) },
        });
      }

      // ---------- LINE webhook: จำ groupId ของกลุ่มที่เชิญบอทเข้าไป ----------
      if (m === 'POST' && path === '/line/webhook') {
        const body = await req.text();
        const logHit = (o) => putJson(env, 'data/line/last.json', { at: new Date().toISOString(), ...o }).catch(() => {});
        if (!env.LINE_SECRET) { await logHit({ step: 'no LINE_SECRET' }); return json(env, { ok: true, note: 'ตั้ง LINE_SECRET ก่อน บอทจึงจะทำงาน' }); }
        if (!(await hmacOk(env, body, req.headers.get('x-line-signature') || ''))) { await logHit({ step: 'bad signature' }); return fail(env, 401, 'bad signature'); }
        let j = {}; try { j = JSON.parse(body); } catch {}
        const evs = (j.events || []).slice(0, 20);
        await logHit({ step: 'received', events: evs.map((e) => ({ type: e.type, msg: e.message && e.message.type, text: e.message && e.message.text ? String(e.message.text).slice(0, 40) : undefined, src: e.source && e.source.type })) });
        ctx.waitUntil((async () => { for (const ev of evs) { try { await handleLineEvent(env, ev, url.origin); } catch (e) { await putJson(env, 'data/line/error.json', { at: new Date().toISOString(), error: String(e && e.stack || e).slice(0, 800) }).catch(() => {}); } } })());
        return json(env, { ok: true });
      }

      if (!path.startsWith('/api/')) return fail(env, 404, 'ไม่พบหน้า');
      const origin = url.origin;

      const role = roleOf(req, env);
      if (!role) return fail(env, 401, 'รหัสแอปไม่ถูกต้อง');
      const seg = path.split('/').slice(2); // หลัง /api/

      // GET /api/line/status?pin=88888888  ดูว่าบอทพร้อมไหม และรับ webhook ล่าสุดเมื่อไร
      if (m === 'GET' && seg[0] === 'line' && seg[1] === 'status') {
        const pin = url.searchParams.get('pin') || '';
        if (!(pin === '88888888' || (env.ADMIN_KEY && pin === env.ADMIN_KEY))) return fail(env, 403, 'รหัสไม่ถูกต้อง');
        let bot = null;
        if (env.LINE_TOKEN) { try { const r = await lineApi(env, '/v2/bot/info'); bot = r.ok ? await r.json() : { error: r.status + ' ' + (await r.text()).slice(0, 200) }; } catch (e) { bot = { error: String(e) }; } }
        let wh = null;
        if (env.LINE_TOKEN) { try { const r = await lineApi(env, '/v2/bot/channel/webhook/endpoint'); wh = r.ok ? await r.json() : { error: r.status }; } catch (e) { wh = { error: String(e) }; } }
        const pend = await env.BUCKET.list({ prefix: 'data/line/pending/', limit: 20 });
        return json(env, {
          hasToken: !!env.LINE_TOKEN, hasSecret: !!env.LINE_SECRET, hasAI: !!env.AI,
          bot: bot && { name: bot.displayName, basicId: bot.basicId, chatMode: bot.chatMode, error: bot.error },
          webhook: wh, target: await getJson(env, 'data/line/target.json', null),
          lastWebhook: await getJson(env, 'data/line/last.json', null), lastError: await getJson(env, 'data/line/error.json', null), lastOcr: await getJson(env, 'data/line/ocr.json', null),
          pending: await Promise.all(pend.objects.map((o) => getJson(env, o.key, null).then((x) => x && { name: x.name, at: new Date(x.at).toISOString(), carId: x.carId, typedOdo: x.typedOdo, hasPhoto: !!x.photo, processing: !!x.processing, waitOdo: !!x.waitOdo, ocr: x.ocr }))),
          cars: ((await getJson(env, 'data/cars.json', [])) || []).map((c) => ({ id: c.id, plate: c.plate })),
        });
      }

      // GET /api/line/ocrtest?pin=88888888  ลองอ่านรูปหน้าปัดของรายการวันนี้ใหม่ (ไม่บันทึกอะไร)
      if (m === 'GET' && seg[0] === 'line' && seg[1] === 'ocrtest') {
        const pin = url.searchParams.get('pin') || '';
        if (!(pin === '88888888' || (env.ADMIN_KEY && pin === env.ADMIN_KEY))) return fail(env, 403, 'รหัสไม่ถูกต้อง');
        const day = url.searchParams.get('date') || bkkNow().date;
        const page = await env.BUCKET.list({ prefix: 'data/records/' + day.slice(0, 7) + '/' + day + '_', limit: 50 });
        const out = [];
        for (const o of page.objects.slice(0, 6)) {
          const r = await getJson(env, o.key, null);
          const ph = r && String(r.photoOdo || '').split('/photos/')[1];
          if (!ph) continue;
          const obj = await env.BUCKET.get('photos/' + ph); if (!obj) continue;
          const bytes = new Uint8Array(await obj.arrayBuffer());
          const res = await readDash(env, bytes);
          out.push({ key: o.key, saved: { odo: r.odo, fuel: r.fuel, fs: r.fs }, read: res });
        }
        return json(env, out);
      }

      // GET /api/line/test?pin=88888888  ส่งการ์ดทดสอบเข้า LINE
      if (m === 'GET' && seg[0] === 'line' && seg[1] === 'test') {
        const pin = url.searchParams.get('pin') || '';
        if (!(pin === '88888888' || (env.ADMIN_KEY && pin === env.ADMIN_KEY))) return fail(env, 403, 'รหัสไม่ถูกต้อง');
        const res = await linePush(env, 'ทดสอบแจ้งเตือน Fleet Daily Check', card('#16202E', 'FLEET DAILY CHECK · 2PS', '✅ ทดสอบแจ้งเตือน', [row('ℹ️', 'สถานะ', 'เชื่อม LINE สำเร็จ')], null, origin + '/'));
        return json(env, res, res.ok ? 200 : 400);
      }

      // GET /api/ping
      if (m === 'GET' && seg[0] === 'ping') return json(env, { ok: true, role, time: new Date().toISOString() });

      // ---------- รถ ----------
      if (seg[0] === 'cars' && seg.length === 1) {
        if (m === 'GET') return json(env, await getJson(env, 'data/cars.json', []));
        if (m === 'PUT') {
          // ทุกคนเพิ่ม/แก้/ลบรถได้ (ไม่ต้องใช้รหัสแอดมิน)
          const cars = await readJson(req, env);
          if (!Array.isArray(cars) || cars.some((c) => !c || !ID_RE.test(String(c.id)))) return fail(env, 400, 'รูปแบบรายการรถไม่ถูกต้อง');
          await putJson(env, 'data/cars.json', cars);
          return json(env, { ok: true });
        }
      }

      // ---------- งานซ่อม ----------
      if (seg[0] === 'repairs') {
        if (m === 'GET' && seg.length === 1) return json(env, await readAll(env, 'data/repairs/'));
        if (m === 'PUT' && seg.length === 2) {
          const id = seg[1];
          if (!ID_RE.test(id)) return fail(env, 400, 'รหัสงานซ่อมไม่ถูกต้อง');
          const t = await readJson(req, env);
          if (!t || t.id !== id || !ID_RE.test(String(t.carId))) return fail(env, 400, 'ข้อมูลงานซ่อมไม่ถูกต้อง');
          const key = 'data/repairs/' + id + '.json';
          // ทุกคนเปิดงานซ่อมและเปลี่ยนสถานะซ่อมได้ (ไม่ต้องใช้รหัสแอดมิน)
          const prevT = await getJson(env, key, null);
          await putJson(env, key, t);
          if (!prevT && env.LINE_TOKEN && env.LINE_PUSH === 'true') ctx.waitUntil(notifyRepair(env, t, origin).catch(() => {}));
          return json(env, { ok: true });
        }
      }

      // ---------- เลขไมล์ / น้ำมัน รายวัน ----------
      if (seg[0] === 'records') {
        if (m === 'GET' && seg.length === 1) {
          const month = url.searchParams.get('month') || '';
          if (!MONTH_RE.test(month)) return fail(env, 400, 'ระบุเดือนแบบ YYYY-MM');
          return json(env, await readAll(env, 'data/records/' + month + '/'));
        }
        // PUT /api/records/<date>/<carId>      = ขาไป
        // PUT /api/records/<date>/<carId>/in   = ขากลับ
        if (m === 'PUT' && (seg.length === 3 || (seg.length === 4 && seg[3] === 'in'))) {
          const [, date, carId] = seg;
          const trip = seg[3] === 'in' ? 'in' : 'out';
          if (!DATE_RE.test(date) || !ID_RE.test(carId)) return fail(env, 400, 'วันที่หรือรหัสรถไม่ถูกต้อง');
          const r = await readJson(req, env);
          if (!r || r.date !== date || r.carId !== carId) return fail(env, 400, 'ข้อมูลไม่ตรงกับวันที่/รถ');
          if ((r.trip === 'in' ? 'in' : 'out') !== trip) return fail(env, 400, 'ข้อมูลไม่ตรงกับเที่ยว (ขาไป/ขากลับ)');
          if (typeof r.odo !== 'number' || r.odo < 0) return fail(env, 400, 'เลขไมล์ไม่ถูกต้อง');
          if (String(r.photoOdo || '').startsWith('data:') || String(r.photoBill || '').startsWith('data:')) return fail(env, 400, 'ต้องอัปโหลดรูปก่อน');
          const rKey = 'data/records/' + date.slice(0, 7) + '/' + date + '_' + carId + (trip === 'in' ? '_in' : '') + '.json';
          const existed = !!(await env.BUCKET.head(rKey));
          await putJson(env, rKey, r);
          if (env.LINE_TOKEN && env.LINE_PUSH === 'true') ctx.waitUntil(notifyRecord(env, r, existed, origin).catch(() => {}));
          return json(env, { ok: true });
        }
      }

      // ---------- อัปโหลดรูป ----------
      // PUT /api/photos/<YYYY-MM>/<ชื่อ>.jpg  (body = ไฟล์ jpeg)
      if (seg[0] === 'photos' && m === 'PUT') {
        const name = seg.slice(1).join('/');
        if (!PHOTO_RE.test(name)) return fail(env, 400, 'ชื่อไฟล์รูปไม่ถูกต้อง');
        const len = Number(req.headers.get('Content-Length') || 0);
        if (len > MAX_PHOTO) return fail(env, 413, 'รูปใหญ่เกิน 3 MB');
        const buf = await req.arrayBuffer();
        if (buf.byteLength > MAX_PHOTO) return fail(env, 413, 'รูปใหญ่เกิน 3 MB');
        const b = new Uint8Array(buf, 0, Math.min(3, buf.byteLength));
        if (!(b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff)) return fail(env, 400, 'รับเฉพาะไฟล์ JPEG');
        await env.BUCKET.put('photos/' + name, buf, { httpMetadata: { contentType: 'image/jpeg' } });
        return json(env, { ok: true, path: '/photos/' + name });
      }

      return fail(env, 404, 'ไม่พบคำสั่งนี้');
    } catch (e) {
      return fail(env, 400, e && e.message ? e.message : 'เกิดข้อผิดพลาด');
    }
  },
};
