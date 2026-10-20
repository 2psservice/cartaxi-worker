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
    'Access-Control-Allow-Methods': 'GET,PUT,DELETE,OPTIONS',
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
async function aiRun(env, model, input) {
  try { return await env.AI.run(model, input); }
  catch (e) {
    if (/agree/i.test(String(e && e.message))) { await env.AI.run(model, { prompt: 'agree' }); return env.AI.run(model, input); }
    throw e;
  }
}

const DASH_PROMPT =
  'Look at this photo and classify it.\n' +
  '- "dash": a car instrument cluster / dashboard.\n' +
  '- "bill": a fuel station receipt / tax invoice.\n' +
  '- "slip": a bank / mobile-banking money transfer slip (e.g. "โอนเงินสำเร็จ").\n' +
  '- "other": anything else.\n' +
  'If "dash": ODOMETER = total distance in km. Digital clusters: the value labelled ODO (ignore TRIP A/B, range, clock, temperature). ' +
  'Analog clusters: the 6-digit rolling counter inside the speedometer (ignore the smaller trip counter). ' +
  'FUEL = fuel gauge (fuel-pump icon; ends marked E/F or 0/1). Analog needle: E=0, 1/4=25, 1/2=50, 3/4=75, F=100, estimate where the needle points. ' +
  'Segmented LCD bar (a column of dark blocks inside a bracket from 0/E at the bottom to 1/F at the top): unlit blocks are INVISIBLE, so a short stack of blocks near 0 is NOT empty. ' +
  'Count the dark blocks (fuel_bars) and estimate how many blocks would fit from 0 to 1 (fuel_total, usually 8; a tick at the middle of the bracket = half). fuel = fuel_bars / fuel_total x 100. ' +
  'fuel is 0 only when no block at all is lit. Round to nearest 10. null only if no fuel gauge is visible.\n' +
  'If "bill": LITERS = fuel quantity in litres (the Quantity / จำนวน / ลิตร column), COST = total amount paid in baht (NET TOTAL / จำนวนเงินรวม / Amount).\n' +
  'If "slip": AMOUNT = the transferred amount in baht (จำนวนเงิน).\n' +
  'Answer with ONLY compact JSON and nothing else: {"kind":"dash|bill|slip|other","odo":<int or null>,"fuel_bars":<int or null>,"fuel_total":<int or null>,"fuel":<int 0-100 or null>,"liters":<number or null>,"cost":<number or null>,"amount":<number or null>}';
const FUEL_PROMPT =
  'Look ONLY at the fuel gauge of this car dashboard (the part next to the fuel-pump icon). ' +
  'If it is a needle: where does it point between E (0) and F (100)? ' +
  'If it is a column of dark rectangular blocks inside a bracket from 0 (bottom) to 1 (top): count every dark filled rectangle stacked up from the bottom, even small ones at the very bottom next to the 0 (fuel_bars), ' +
  'and how many such rectangles would fill the bracket from 0 to 1 (fuel_total, usually 8). ' +
  'Answer ONLY compact JSON: {"fuel_bars":<int or null>,"fuel_total":<int or null>,"fuel":<int 0-100>}';
/* อัตราใช้น้ำมัน (% ต่อ กม.) ของรถคันนี้ จากประวัติช่วงที่ไม่ได้เติม · ไม่มีข้อมูลใช้ 0.2%/กม. (~500 กม./ถัง) */
function fuelRate(recs) {
  const l = (recs || []).filter((r) => r && r.odo && r.fuel != null);
  const rates = [];
  for (let i = 1; i < l.length; i++) {
    const a = l[i - 1], b = l[i], km = b.odo - a.odo, d = fuelPct(a) - fuelPct(b);
    if (km >= 30 && d > 0 && !b.liters) rates.push(d / km);
  }
  if (rates.length < 2) return 0.2;
  rates.sort((x, y) => x - y);
  return Math.max(0.05, Math.min(0.8, rates[Math.floor(rates.length / 2)]));
}
async function readOdoHint(env, bytes, prevOdo) {
  const text = 'Read the ODOMETER of this car dashboard: the total distance in km (labelled ODO on digital clusters, or the 6-digit rolling counter inside an analog speedometer). Ignore TRIP, RANGE, km/l, clock. ' +
    'Hint: the previous reading of this car was ' + prevOdo + ' km, so the odometer should be the same number of digits and a little higher. Read every digit carefully from left to right. ' +
    'Answer ONLY JSON {"odo":<int>}';
  try {
    const o = await aiRun(env, '@cf/meta/llama-4-scout-17b-16e-instruct', { messages: [{ role: 'user', content: [{ type: 'text', text }, { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,' + b64(bytes) } }] }], max_tokens: 60, temperature: 0 });
    return parseDash(o).odo;
  } catch (e) { return null; }
}
function num(v) { if (v == null || v === '') return null; const n = Number(String(v).replace(/[^\d.]/g, '')); return Number.isFinite(n) && n > 0 ? n : null; }
function parseDash(out) {
  let v = out && typeof out === 'object' && 'response' in out ? out.response : out;
  if (v && typeof v === 'object' && v.choices) v = v.choices[0] && v.choices[0].message && v.choices[0].message.content;
  let j = {}, txt;
  if (v && typeof v === 'object') { j = v; txt = JSON.stringify(v); }
  else {
    txt = String(v == null ? '' : v);
    const all = txt.match(/\{[^{}]*\}/g) || [], m = all.length ? [all[all.length - 1]] : null;   // เอา JSON ก้อนสุดท้าย (กรณี AI อธิบายก่อนตอบ)
    try { j = m ? JSON.parse(m[0]) : {}; } catch {}
  }
  const kind = ['dash', 'bill', 'slip', 'other'].includes(String(j.kind)) ? String(j.kind) : null;
  const odo = num(j.odo) != null ? Math.round(num(j.odo)) : null;
  const fr = j.fuel == null || j.fuel === '' ? null : Number(String(j.fuel).replace(/[^\d.]/g, ''));
  let fuel = fr == null || !Number.isFinite(fr) ? null : Math.max(0, Math.min(100, Math.round(fr / 10) * 10));
  const fb = Number(j.fuel_bars), ft = Number(j.fuel_total);   // แบบขีด: นับขีดเอง แม่นกว่าให้ AI คิด %
  if (Number.isFinite(fb) && fb > 0 && Number.isFinite(ft) && ft >= fb && ft <= 16) fuel = Math.round(fb / ft * 10) * 10;
  return { kind, odo, fuel, liters: num(j.liters), cost: num(j.cost), amount: num(j.amount), raw: txt.slice(0, 200) };
}
/* อ่านรูป: Llama 4 Scout ก่อน ถ้าขาดค่าไหนลอง Llama 3.2 Vision แล้วรวมผล */
async function readDash(env, bytes) {
  if (!env.AI) return { kind: null, odo: null, fuel: null, liters: null, cost: null, log: ['ยังไม่ได้ผูก Workers AI'] };
  const url = 'data:image/jpeg;base64,' + b64(bytes);
  const tries = [
    ['@cf/meta/llama-4-scout-17b-16e-instruct', { messages: [{ role: 'user', content: [{ type: 'text', text: DASH_PROMPT }, { type: 'image_url', image_url: { url } }] }], max_tokens: 130, temperature: 0 }],
    [VISION_MODEL, { prompt: DASH_PROMPT, image: [...bytes], max_tokens: 130, temperature: 0 }],
  ];
  const res = { kind: null, odo: null, fuel: null, liters: null, cost: null, amount: null, log: [] };
  const done = () => res.kind === 'other' || (res.kind === 'slip' && res.amount != null) || (res.kind === 'bill' && res.liters != null && res.cost != null) || (res.kind === 'dash' && res.odo != null && res.fuel != null);
  for (const [model, input] of tries) {
    if (done()) break;
    try {
      const r = parseDash(await aiRun(env, model, input));
      res.log.push(model.split('/').pop() + ': ' + r.raw);
      for (const k of ['kind', 'odo', 'fuel', 'liters', 'cost', 'amount']) if (res[k] == null && r[k] != null) res[k] = r[k];
    } catch (e) { res.log.push(model.split('/').pop() + ' ERR ' + String(e && e.message || e).slice(0, 120)); }
  }
  if (!res.kind) res.kind = res.odo != null ? 'dash' : res.liters != null || res.cost != null ? 'bill' : 'other';
  if (res.kind === 'dash' && !res.fuel) {   // น้ำมัน 0/อ่านไม่ได้ = น่าสงสัย ถามซ้ำเฉพาะเกจน้ำมัน
    try {
      const out = await aiRun(env, '@cf/meta/llama-4-scout-17b-16e-instruct', { messages: [{ role: 'user', content: [{ type: 'text', text: FUEL_PROMPT }, { type: 'image_url', image_url: { url } }] }], max_tokens: 500, temperature: 0 });
      const r = parseDash(out);
      res.log.push('fuel-recheck: ' + (r.raw.length > 190 ? '…' + String(typeof out === 'object' && out && 'response' in out ? out.response : out).slice(-160) : r.raw));
      if (r.fuel) res.fuel = r.fuel;
    } catch (e) { res.log.push('fuel-recheck ERR ' + String(e && e.message || e).slice(0, 120)); }
  }
  await putJson(env, 'data/line/ocr.json', { at: new Date().toISOString(), ...res }).catch(() => {});
  return res;
}

async function savePhoto(env, bytes) {
  if (!(bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff)) return null;
  const now = bkkNow();
  const name = now.date.slice(0, 7) + '/' + (rid() + rid()).toLowerCase().replace(/[^a-z0-9]/g, '') + '.jpg';
  await env.BUCKET.put('photos/' + name, bytes, { httpMetadata: { contentType: 'image/jpeg' } });
  return name;
}

/* ===== ที่พักข้อมูลต่อคนส่ง: data/line/p/<userId>/  car.json = เบอร์รถ · img-<id>.json = ผลอ่านแต่ละรูป ===== */
const PDIR = (uid) => 'data/line/p/' + uid + '/';
async function listUser(env, uid) {
  const page = await env.BUCKET.list({ prefix: PDIR(uid), limit: 100 });
  const out = { car: null, imgs: [], keys: page.objects.map((o) => o.key) };
  for (const k of out.keys) {
    const x = await getJson(env, k, null); if (!x) continue;
    if (Date.now() - (x.at || 0) > PAIR_MS) { await env.BUCKET.delete(k); continue; }
    if (k.endsWith('/car.json')) out.car = x; else if (k.includes('/img-')) out.imgs.push(x);
  }
  out.imgs.sort((a, b) => (a.set && b.set && a.set.id === b.set.id ? a.set.index - b.set.index : a.at - b.at));
  return out;
}
async function clearUser(env, uid) {
  const page = await env.BUCKET.list({ prefix: PDIR(uid), limit: 100 });
  for (const o of page.objects) await env.BUCKET.delete(o.key);
}

/* รวมรูป (หน้าปัด/บิล) + เบอร์รถ แล้วบันทึก — เรียกทุกครั้งที่มีรูปอ่านเสร็จหรือมีคนพิมพ์เบอร์รถ */
async function tryComplete(env, uid, replyToken, origin) {
  const u = await listUser(env, uid);
  if (u.imgs.some((x) => x.processing)) return false;                       // ยังอ่านรูปไม่เสร็จ
  u.imgs = u.imgs.filter((x) => x.kind !== 'slip');                         // สลิปโอนเงินไม่ใช่หน้าปัด
  if (!u.car || !u.imgs.length) return false;
  if (!u.imgs.some((x) => x.kind === 'dash' || x.kind === 'bill' || x.odo != null) && !u.car.typedOdo) return false;   // ไม่มีรูปหน้าปัด/บิล = ไม่ใช่การส่งเลขไมล์
  const last = u.imgs[u.imgs.length - 1];
  if (last.set && u.imgs.filter((x) => x.set && x.set.id === last.set.id).length < last.set.total) return false;   // อัลบั้มยังมาไม่ครบ
  const claimKey = PDIR(uid) + 'claim.json';
  const claim = await getJson(env, claimKey, null);
  if (claim && Date.now() - claim.at < 60000) return false;                // อีกงานกำลังบันทึกอยู่
  await putJson(env, claimKey, { at: Date.now() });

  const cars = await getJson(env, 'data/cars.json', []);
  const car = (cars || []).find((c) => c.id === u.car.carId);
  if (!car) { await env.BUCKET.delete(claimKey); return false; }
  const dashes = u.imgs.filter((x) => x.kind === 'dash' || (x.kind !== 'bill' && x.odo != null));
  const bills = u.imgs.filter((x) => x.kind === 'bill');
  const bill = bills[bills.length - 1] || null;
  const readOdo = dashes.reduce((m, x) => (x.odo != null && (m == null || x.odo > m) ? x.odo : m), null);
  const recs = await carRecords(env, car.id);
  const now = bkkNow();
  const trip = recs.some((r) => r.date === now.date && r.trip !== 'in') ? 'in' : 'out';
  const prev = recs.filter((r) => (r.date + (r.trip === 'in' ? 'b' : 'a')) < (now.date + (trip === 'in' ? 'b' : 'a'))).pop() || null;
  const dashPick = dashes.filter((x) => x.odo === readOdo).pop() || dashes[dashes.length - 1] || null;
  let odo = u.car.typedOdo || readOdo;
  const okOdo = (v) => v && (!prev || (v >= prev.odo && v - prev.odo <= MAX_KM_DAY));
  if (!u.car.typedOdo && !okOdo(odo) && prev) {   // อ่านเลขไมล์ไม่ผ่าน → ให้ AI อ่านซ้ำโดยบอกเลขไมล์ครั้งก่อนเป็นตัวช่วย
    for (const x of dashes.slice().reverse()) {
      const obj = x.photo ? await env.BUCKET.get('photos/' + x.photo) : null; if (!obj) continue;
      const v = await readOdoHint(env, new Uint8Array(await obj.arrayBuffer()), prev.odo);
      if (okOdo(v)) { odo = v; break; }
    }
  }
  const plate = 'รถ ' + (car.plate || car.id);
  const carNo = String(car.plate || car.id).replace(/\D/g, '') || String(car.plate);
  const bad = !odo ? 'อ่านเลขไมล์จากรูปไม่ได้'
    : prev && odo < prev.odo ? 'เลขไมล์ที่อ่านได้ ' + nf(odo) + ' น้อยกว่าครั้งก่อน (' + nf(prev.odo) + ')'
    : prev && odo - prev.odo > MAX_KM_DAY ? 'เลขไมล์ที่อ่านได้ ' + nf(odo) + ' มากกว่าครั้งก่อนเกิน ' + MAX_KM_DAY + ' กม.' : '';
  if (bad && (!u.car.typedOdo || (prev && odo < prev.odo))) {
    await env.BUCKET.delete(claimKey);
    await lineReply(env, replyToken, [textMsg('⚠️ ' + plate + ': ' + bad + '\nกรุณาพิมพ์เบอร์รถตามด้วยเลขไมล์ เช่น  ' + carNo + ' ' + (prev ? prev.odo + 50 : 123456))]);
    return true;
  }
  // หน้าปัดที่ใช้: รูปที่เลขไมล์มากสุด (หลังเติม) · น้ำมัน: มีบิลเติม = 100% ไม่งั้นใช้ค่าจากหน้าปัดรูปล่าสุดที่อ่านได้
  const aiFuel = (dashes.slice().reverse().find((x) => x.fuel != null) || {}).fuel ?? null;
  let fuelPctV = bill ? 100 : aiFuel, fuelWarn = '';
  const pf = fuelPct(prev);
  if (!bill && pf != null && odo >= prev.odo) {   // เทียบกับที่ควรเหลือ (น้ำมันครั้งก่อน − ระยะที่วิ่ง × อัตราใช้ของรถคันนี้)
    const exp = Math.max(0, Math.min(100, Math.round((pf - (odo - prev.odo) * fuelRate(recs)) / 10) * 10));
    if (aiFuel == null) { fuelPctV = exp; fuelWarn = 'AI อ่านระดับน้ำมันไม่ได้ ใส่ค่าประมาณจากระยะทาง ' + exp + '% ไว้ก่อน'; }
    else if (Math.abs(aiFuel - exp) > 20) { fuelPctV = exp; fuelWarn = 'AI อ่านได้ ' + aiFuel + '% แต่จากระยะทางควรเหลือราว ' + exp + '% จึงบันทึก ' + exp + '% ไว้ก่อน'; }
  }
  const r = {
    id: rid(), date: now.date, trip, time: now.time, carId: car.id, driver: u.car.name || 'คนขับ',
    odo, fuel: fuelPctV == null ? null : fuelPctV / 10, fs: 10, km: prev ? odo - prev.odo : null,
    liters: bill ? bill.liters : null, cost: bill ? bill.cost : null,
    photoOdo: dashPick && dashPick.photo ? origin + '/photos/' + dashPick.photo : null,
    photoBill: bill && bill.photo ? origin + '/photos/' + bill.photo : null,
    note: (u.car.typedOdo ? 'เลขไมล์พิมพ์ใน LINE' : 'อ่านจากรูปใน LINE อัตโนมัติ') + (bill ? ' · เติมน้ำมัน (เต็มถัง)' : '') + (fuelWarn ? ' · น้ำมันประมาณจากระยะทาง' : ''), route: '', src: 'line',
  };
  const key = 'data/records/' + now.date.slice(0, 7) + '/' + now.date + '_' + car.id + (trip === 'in' ? '_in' : '') + '.json';
  await putJson(env, key, r);
  await clearUser(env, uid);

  const isIn = trip === 'in', fp = fuelPct(r);
  const head = '✅ บันทึก' + (isIn ? 'ขากลับ' : 'ขาไป') + ' รถ ' + (car.plate || car.id) + ' · ' + r.driver + ' · ' + r.time + ' น.' + (bill ? ' · เติมน้ำมัน' : '');
  const msgs = [await fleetTable(env, origin, car.id, head)];
  const qr = { items: [0, 10, 20, 30, 40, 50, 60, 70, 80, 90, 100].map((v) => ({ type: 'action', action: { type: 'message', label: v + '%', text: carNo + ' น้ำมัน ' + v + '%' } })) };
  msgs.push({ type: 'text', text: fuelWarn ? '⛽ ' + fuelWarn + '\nกรุณาดูหน้าปัดแล้วแตะเลือกค่าที่ถูกด้านล่าง' : fp == null ? '⛽ อ่านระดับน้ำมันจากรูปไม่ได้ แตะเลือกด้านล่างได้เลย' : '⛽ ระดับน้ำมันไม่ตรง? แตะเลือกค่าที่ถูกด้านล่าง', quickReply: qr });
  await lineReply(env, replyToken, msgs);
  return true;
}

/* สลิปโอนค่าน้ำมัน + ข้อความ "ค่าน้ำมันรถ 04" → บันทึกเงินโอนค่าน้ำมันของรถคันนั้น */
async function tryAdvance(env, uid, replyToken, origin) {
  const adv = await getJson(env, PDIR(uid) + 'adv.json', null);
  if (!adv || Date.now() - adv.at > PAIR_MS) return false;
  const u = await listUser(env, uid);
  if (u.imgs.some((x) => x.processing)) return false;
  const slip = u.imgs.filter((x) => x.kind === 'slip').pop();
  if (!slip) return false;
  const cars = await getJson(env, 'data/cars.json', []);
  const car = (cars || []).find((c) => c.id === adv.carId);
  if (!car) return false;
  const now = bkkNow();
  const a = { id: rid(), date: now.date, time: now.time, carId: car.id, amount: slip.amount, by: adv.name || '', photo: slip.photo ? origin + '/photos/' + slip.photo : null, src: 'line' };
  await putJson(env, 'data/advances/' + now.date.slice(0, 7) + '/' + now.date + '_' + a.id + '.json', a);
  for (const k of u.keys) { const x = await getJson(env, k, null); if (k.endsWith('/adv.json') || (x && x.kind === 'slip' && x.photo === slip.photo)) await env.BUCKET.delete(k); }
  await lineReply(env, replyToken, [textMsg('💸 บันทึกโอนค่าน้ำมัน รถ ' + car.plate + (a.amount ? ' · ' + nf(a.amount) + ' บาท' : ' (อ่านยอดเงินไม่ได้ แก้ในแอป)'))]);
  return true;
}

/* การ์ดตารางสั้น รถ | เลขไมล์ | น้ำมัน (ตอบกลับหลังพนักงานส่งรูปหน้าปัด) */
async function fleetTable(env, origin, hiId, head) {
  const cars = ((await getJson(env, 'data/cars.json', [])) || []).filter((c) => c && c.id);
  const now = bkkNow();
  const pm = new Date(Date.now() + 7 * 3600e3); pm.setUTCDate(1); pm.setUTCMonth(pm.getUTCMonth() - 1);
  let recs = [];
  for (const m of [now.date.slice(0, 7), pm.toISOString().slice(0, 7)]) recs = recs.concat(await readAll(env, 'data/records/' + m + '/'));
  const ord = (r) => r.date + (r.trip === 'in' ? 'b' : 'a') + (r.time || '');
  const cell = (t, o) => Object.assign({ type: 'text', text: t, size: 'xs', color: '#111827' }, o || {});
  let old0 = false;
  const H = (t, f, al) => cell(t, { flex: f, color: '#6B7280', size: 'xxs', align: al || 'start', wrap: true });
  const rows = [{ type: 'box', layout: 'horizontal', paddingAll: '6px', spacing: 'sm', backgroundColor: '#F3F4F6', cornerRadius: '6px', alignItems: 'center', contents: [
    H('รถ', 2), H('คนขับ', 4), H('ไมล์ขาไป', 4, 'end'), H('ไมล์ขากลับ', 4, 'end'), H('น้ำมัน', 6, 'center'),
  ] }];
  for (const c of cars) {
    const l = recs.filter((r) => r.carId === c.id).sort((a, b) => (ord(a) < ord(b) ? -1 : 1));
    const last = l[l.length - 1] || null;
    const day = last ? last.date : '';                       // วันล่าสุดที่มีข้อมูล (ปกติ = วันนี้)
    const tOut = l.find((r) => r.date === day && r.trip !== 'in');
    const tIn = l.find((r) => r.date === day && r.trip === 'in');
    const old = day && day !== now.date;                      // ไม่ใช่ของวันนี้ = ตัวเทา
    if (old) old0 = true;
    const tc = old ? '#9CA3AF' : '#111827';
    const fp = fuelPct(last);
    const col = fp == null ? '#9CA3AF' : fp <= 25 ? '#C8372D' : '#1F8A4C';
    const hi = c.id === hiId;
    const drv = (tIn && tIn.driver) || (tOut && tOut.driver) || '—';
    rows.push({ type: 'box', layout: 'horizontal', paddingAll: '6px', spacing: 'sm', cornerRadius: '6px', alignItems: 'center', backgroundColor: hi ? '#E7F5EC' : '#FFFFFF', contents: [
      cell(String(c.plate || c.id), { flex: 2, weight: 'bold', size: 'sm' }),
      cell(drv, { flex: 4, color: tc, wrap: false }),
      cell(tOut ? nf(tOut.odo) : '—', { flex: 4, align: 'end', color: tOut ? tc : '#9CA3AF', weight: hi && !tIn ? 'bold' : 'regular' }),
      cell(tIn ? nf(tIn.odo) : '—', { flex: 4, align: 'end', color: tIn ? tc : '#9CA3AF', weight: hi && tIn ? 'bold' : 'regular' }),
      { type: 'box', layout: 'horizontal', flex: 6, spacing: 'sm', alignItems: 'center', contents: [
        { type: 'box', layout: 'vertical', flex: 3, height: '10px', backgroundColor: '#E5E7EB', cornerRadius: '5px', contents: [
          { type: 'box', layout: 'vertical', height: '10px', width: Math.max(0, Math.min(100, fp || 0)) + '%', backgroundColor: col, cornerRadius: '5px', contents: [] },
        ] },
        cell(fp == null ? '—' : fp + '%', { flex: 2, align: 'end', size: 'xxs', color: fp == null ? '#9CA3AF' : fp <= 25 ? '#C8372D' : '#111827' }),
      ] },
    ] });
    rows.push({ type: 'separator', color: '#EEEEEE' });
  }
  rows.pop();
  const contents = (head ? [cell(head, { size: 'xs', color: '#1F8A4C', weight: 'bold', wrap: true, margin: 'none' }), { type: 'box', layout: 'vertical', height: '8px', contents: [] }] : []).concat(rows);
  return { type: 'flex', altText: (head || 'สรุปรถ') + ' · รถ/เลขไมล์/น้ำมัน', contents: {
    type: 'bubble', size: 'giga',
    body: { type: 'box', layout: 'vertical', paddingAll: '12px', contents: contents.concat(old0 ? [cell('ตัวเทา = ข้อมูลวันก่อน (วันนี้ยังไม่ส่ง)', { size: 'xxs', color: '#9CA3AF', margin: 'md' })] : []) },
    footer: { type: 'box', layout: 'vertical', paddingAll: '4px', contents: [
      { type: 'button', style: 'link', height: 'sm', action: { type: 'uri', label: 'เปิดแอป', uri: origin + '/' } },
    ] },
  } };
}

/* การ์ดสรุปรถทุกคัน (ตอบกลับเมื่อพิมพ์ "สรุปรถ" ในกลุ่ม → ฟรี) */
async function fleetSummary(env, origin) {
  const cars = ((await getJson(env, 'data/cars.json', [])) || []).filter((c) => c && c.id);
  const now = bkkNow();
  const months = [now.date.slice(0, 7)];
  const pm = new Date(Date.now() + 7 * 3600e3); pm.setUTCDate(1); pm.setUTCMonth(pm.getUTCMonth() - 1); months.push(pm.toISOString().slice(0, 7));
  let recs = [];
  for (const m of months) recs = recs.concat(await readAll(env, 'data/records/' + m + '/'));
  const reps = await readAll(env, 'data/repairs/');
  const ord = (r) => r.date + (r.trip === 'in' ? 'b' : 'a') + (r.time || '');
  const rows = [];
  for (const c of cars) {
    const l = recs.filter((r) => r.carId === c.id).sort((a, b) => (ord(a) < ord(b) ? -1 : 1));
    const last = l[l.length - 1] || null;
    const tOut = l.find((r) => r.date === now.date && r.trip !== 'in');
    const tIn = l.find((r) => r.date === now.date && r.trip === 'in');
    const open = reps.filter((t) => t.carId === c.id && t.status !== 'done').sort((a, b) => (a.at < b.at ? 1 : -1))[0];
    const fp = fuelPct(last);
    const col = fp == null ? '#9CA3AF' : fp <= 25 ? '#C8372D' : fp > 50 ? '#1F8A4C' : '#E8A317';
    const loc = last ? locOf(last) : '';
    const today = open && open.status === 'waiting' ? '🔧 รอซ่อม' : (tOut ? 'ไป ' + tOut.time : 'ไป –') + ' · ' + (tIn ? 'กลับ ' + tIn.time : 'กลับ –');
    rows.push({ type: 'separator', margin: 'md' });
    rows.push({
      type: 'box', layout: 'horizontal', margin: 'md', spacing: 'md', alignItems: 'center', contents: [
        { type: 'text', text: String(c.plate || c.id), weight: 'bold', size: 'lg', flex: 2, color: '#111827' },
        { type: 'box', layout: 'vertical', flex: 5, contents: [
          { type: 'text', text: last ? nf(last.odo) + ' กม.' : 'ยังไม่มีข้อมูล', size: 'sm', weight: 'bold', color: '#111827' },
          { type: 'text', text: ((loc ? '📍 ' + loc + ' · ' : '') + (last ? 'ล่าสุด ' + thDay(last.date).replace(/ \d+$/, '') : '')) || '—', size: 'xxs', color: '#6B7280', wrap: true },
          { type: 'text', text: today, size: 'xxs', color: open && open.status === 'waiting' ? '#C8372D' : (tOut ? '#1F8A4C' : '#B45309') },
        ] },
        { type: 'box', layout: 'vertical', flex: 4, spacing: 'xs', contents: [
          { type: 'text', text: fp == null ? '—' : fp + '%', size: 'sm', weight: 'bold', align: 'end', color: col },
          { type: 'box', layout: 'vertical', height: '8px', backgroundColor: '#E5E7EB', cornerRadius: '4px', contents: [
            { type: 'box', layout: 'vertical', height: '8px', width: Math.max(0, Math.min(100, fp || 0)) + '%', backgroundColor: col, cornerRadius: '4px', contents: [] },
          ] },
        ] },
      ],
    });
  }
  const sent = cars.filter((c) => recs.some((r) => r.carId === c.id && r.date === now.date)).length;
  const bubble = {
    type: 'bubble', size: 'giga',
    header: { type: 'box', layout: 'vertical', backgroundColor: '#16202E', paddingAll: '18px', contents: [
      { type: 'text', text: 'FLEET DAILY CHECK · 2PS', size: 'sm', color: '#E8A317', weight: 'bold' },
      { type: 'text', text: '🚗 สรุปรถทุกคัน', size: 'xl', color: '#FFFFFF', weight: 'bold', margin: 'sm' },
      { type: 'text', text: thDay(now.date) + ' · ' + now.time + ' น. · ส่งวันนี้ ' + sent + '/' + cars.length + ' คัน', size: 'xs', color: '#D5DAE1', margin: 'sm' },
    ] },
    body: { type: 'box', layout: 'vertical', paddingAll: '16px', contents: [
      { type: 'box', layout: 'horizontal', spacing: 'md', contents: [
        { type: 'text', text: 'รถ', size: 'xxs', color: '#6B7280', flex: 2 },
        { type: 'text', text: 'เลขไมล์ล่าสุด / อยู่ที่ / วันนี้', size: 'xxs', color: '#6B7280', flex: 5 },
        { type: 'text', text: 'น้ำมัน', size: 'xxs', color: '#6B7280', flex: 4, align: 'end' },
      ] },
    ].concat(rows) },
    footer: { type: 'box', layout: 'vertical', contents: [
      { type: 'button', style: 'link', height: 'sm', action: { type: 'uri', label: 'เปิดแอป Fleet Daily Check', uri: origin + '/' } },
    ] },
  };
  return { type: 'flex', altText: '🚗 สรุปรถทุกคัน · ส่งวันนี้ ' + sent + '/' + cars.length + ' คัน', contents: bubble };
}

async function handleLineEvent(env, ev, origin) {
  const src = ev.source || {};
  if (src.type === 'group' && src.groupId) {
    const cur = await getJson(env, 'data/line/target.json', null);
    if (!cur || cur.id !== src.groupId) await putJson(env, 'data/line/target.json', { id: src.groupId, type: 'group', at: new Date().toISOString() });
  }
  if (ev.type !== 'message' || !src.userId || !env.LINE_TOKEN) return;
  const msg = ev.message || {}, uid = src.userId;

  if (msg.type === 'image') {
    const ikey = PDIR(uid) + 'img-' + msg.id + '.json';
    const set = msg.imageSet ? { id: msg.imageSet.id, index: msg.imageSet.index || 1, total: msg.imageSet.total || 1 } : null;
    await putJson(env, ikey, { at: Date.now(), processing: true, set });
    const res = await fetch('https://api-data.line.me/v2/bot/message/' + msg.id + '/content', { headers: { Authorization: 'Bearer ' + env.LINE_TOKEN } });
    if (!res.ok) { await env.BUCKET.delete(ikey); return; }
    const bytes = new Uint8Array(await res.arrayBuffer());
    if (bytes.byteLength > 6 * 1024 * 1024) { await env.BUCKET.delete(ikey); return; }
    const [photo, ocr] = await Promise.all([savePhoto(env, bytes), readDash(env, bytes)]);
    await putJson(env, ikey, { at: Date.now(), set, photo, kind: ocr.kind, odo: ocr.odo, fuel: ocr.fuel, liters: ocr.liters, cost: ocr.cost, amount: ocr.amount });
    if (await tryAdvance(env, uid, ev.replyToken, origin)) return;
    await tryComplete(env, uid, ev.replyToken, origin);
    return;
  }
  if (msg.type !== 'text') return;
  if (/^\s*(สรุป|สรุปรถ|สถานะรถ|รถทั้งหมด|สรุปน้ำมัน|สรุปไมล์)\s*$/.test(msg.text || '')) {
    await lineReply(env, ev.replyToken, [await fleetSummary(env, origin)]);
    return;
  }
  const cars = await getJson(env, 'data/cars.json', []);
  const fm = /ค่าน้ำมัน/.test(msg.text || '') ? null : String(msg.text || '').match(/น้ำมัน\s*(\d{1,3})\s*%/);
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
    await lineReply(env, ev.replyToken, [await fleetTable(env, origin, pc.car.id, '✅ แก้น้ำมันรถ ' + pc.car.plate + ' (' + (rec.trip === 'in' ? 'ขากลับ' : 'ขาไป') + ') เป็น ' + v + '%')]);
    return;
  }
  if (/ค่าน้ำมัน/.test(msg.text || '')) {   // "@พัน ค่าน้ำมันรถ 04 ครับ" + สลิปโอนเงิน = โอนค่าน้ำมันให้รถคันนั้น
    const pa = parseCarText(String(msg.text).replace(/@\S+/g, ' '), cars);
    if (!pa) return;
    await putJson(env, PDIR(uid) + 'adv.json', { at: Date.now(), carId: pa.car.id, name: await displayName(env, src) });
    await tryAdvance(env, uid, ev.replyToken, origin);
    return;
  }
  const p = parseCarText(msg.text, cars);
  if (!p) return;
  const old = await getJson(env, PDIR(uid) + 'car.json', null);
  const keep = old && Date.now() - old.at < PAIR_MS && old.carId === p.car.id ? old : null;
  await putJson(env, PDIR(uid) + 'car.json', { at: Date.now(), carId: p.car.id, typedOdo: p.odo || (keep ? keep.typedOdo : null), name: (keep && keep.name) || await displayName(env, src) });
  const u = await listUser(env, uid);
  if (!u.imgs.length) {
    if (p.odo) await lineReply(env, ev.replyToken, [textMsg('รับเลขไมล์ รถ ' + p.car.plate + ' = ' + nf(p.odo) + ' แล้ว กรุณาส่งรูปหน้าปัดตามมาด้วย')]);
    return;
  }
  await tryComplete(env, uid, ev.replyToken, origin);
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
          pending: await Promise.all((await env.BUCKET.list({ prefix: 'data/line/p/', limit: 50 })).objects.map((o) => getJson(env, o.key, null).then((x) => ({ key: o.key.split('/').slice(-1)[0], ...(x || {}), at: x && x.at ? new Date(x.at).toISOString() : null })))),
          cars: ((await getJson(env, 'data/cars.json', [])) || []).map((c) => ({ id: c.id, plate: c.plate })),
        });
      }

      // GET /api/line/ocrlab?pin=88888888&model=scout|mistral|llama32&imgs=d1,d2&p=<prompt>  ทดลองอ่านรูปตัวอย่าง /t/*.jpg
      if (m === 'GET' && seg[0] === 'line' && seg[1] === 'ocrlab') {
        const pin = url.searchParams.get('pin') || '';
        if (!(pin === '88888888' || (env.ADMIN_KEY && pin === env.ADMIN_KEY))) return fail(env, 403, 'รหัสไม่ถูกต้อง');
        const MODELS = { scout: '@cf/meta/llama-4-scout-17b-16e-instruct', mistral: '@cf/mistralai/mistral-small-3.1-24b-instruct', llama32: VISION_MODEL, gemma: '@cf/google/gemma-3-12b-it' };
        const mk = url.searchParams.get('model') || 'pipeline';
        const prompt = url.searchParams.get('p') || (url.searchParams.get('fuel') ? FUEL_PROMPT : DASH_PROMPT);
        const imgs = (url.searchParams.get('imgs') || 'd1,d2,d3,d4,d5,d6').split(',');
        const out = await Promise.all(imgs.map(async (n) => {
          try {
            const rr = env.ASSETS ? await env.ASSETS.fetch(new Request(origin + '/t/' + n + '.jpg')) : await fetch(origin + '/t/' + n + '.jpg');
            const bytes = new Uint8Array(await rr.arrayBuffer());
            if (mk === 'pipeline') return { img: n, res: await readDash(env, bytes) };
            const model = MODELS[mk] || (mk.startsWith('@cf/') ? mk : null);
            if (!model) return { img: n, err: 'unknown model' };
            const input = mk === 'llama32' || url.searchParams.get('raw') ? { prompt, image: [...bytes], max_tokens: 600, temperature: 0 }
              : { messages: [{ role: 'user', content: [{ type: 'text', text: prompt }, { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,' + b64(bytes) } }] }], max_tokens: Number(url.searchParams.get('mt') || 600), temperature: 0 };
            if (url.searchParams.get('nothink')) input.chat_template_kwargs = { enable_thinking: false };
            const o = await aiRun(env, model, input);
            if (o && o.choices) { const c = o.choices[0] || {}; const msg = c.message || {}; return { img: n, content: msg.content, tail: String(msg.reasoning || msg.reasoning_content || '').slice(-300), finish: c.finish_reason, usage: o.usage && { out: o.usage.completion_tokens, neurons: o.usage.neurons } }; }
            return { img: n, raw: typeof o === 'object' && o && 'response' in o ? o.response : o };
          } catch (e) { return { img: n, err: String(e && e.message || e).slice(0, 200) }; }
        }));
        return json(env, out);
      }

      // GET /api/line/ocrtest?pin=88888888  ลองอ่านรูปหน้าปัดของรายการวันนี้ใหม่ (ไม่บันทึกอะไร)
      if (m === 'GET' && seg[0] === 'line' && seg[1] === 'ocrtest') {
        const pin = url.searchParams.get('pin') || '';
        if (!(pin === '88888888' || (env.ADMIN_KEY && pin === env.ADMIN_KEY))) return fail(env, 403, 'รหัสไม่ถูกต้อง');
        const day = url.searchParams.get('date') || bkkNow().date;
        const page = await env.BUCKET.list({ prefix: 'data/records/' + day.slice(0, 7) + '/' + day + '_', limit: 50 });
        const out = [];
        const onlyCar = url.searchParams.get('car') || '';
        for (const o of page.objects.filter((x) => !onlyCar || x.key.includes('_' + onlyCar)).slice(0, 6)) {
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

      // GET /api/line/summary?pin=88888888  ดูข้อมูลการ์ดสรุปรถทุกคัน (JSON)
      if (m === 'GET' && seg[0] === 'line' && seg[1] === 'summary') {
        const pin = url.searchParams.get('pin') || '';
        if (!(pin === '88888888' || (env.ADMIN_KEY && pin === env.ADMIN_KEY))) return fail(env, 403, 'รหัสไม่ถูกต้อง');
        const msgS = url.searchParams.get('table') ? await fleetTable(env, origin, url.searchParams.get('hi') || '', url.searchParams.get('hi') ? '✅ บันทึกขาไป รถ ทดสอบ' : '') : await fleetSummary(env, origin);
        if (url.searchParams.get('validate')) {
          const v = await lineApi(env, '/v2/bot/message/validate/reply', { messages: [msgS] });
          return json(env, { validate: v.status, detail: v.ok ? 'ok' : await v.text(), message: msgS });
        }
        return json(env, msgS);
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

      // ---------- เงินโอนค่าน้ำมัน (จากสลิปในกลุ่ม LINE) ----------
      if (seg[0] === 'advances' && m === 'GET' && seg.length === 1) {
        const month = url.searchParams.get('month') || '';
        if (!MONTH_RE.test(month)) return fail(env, 400, 'ระบุเดือนแบบ YYYY-MM');
        return json(env, await readAll(env, 'data/advances/' + month + '/'));
      }

      // ---------- เลขไมล์ / น้ำมัน รายวัน ----------
      if (seg[0] === 'records') {
        if (m === 'GET' && seg.length === 1) {
          const month = url.searchParams.get('month') || '';
          if (!MONTH_RE.test(month)) return fail(env, 400, 'ระบุเดือนแบบ YYYY-MM');
          return json(env, await readAll(env, 'data/records/' + month + '/'));
        }
        // DELETE /api/records/<date>/<carId>[/in]  = ยกเลิกเที่ยวนั้น
        if (m === 'DELETE' && (seg.length === 3 || (seg.length === 4 && seg[3] === 'in'))) {
          const [, date, carId] = seg;
          if (!DATE_RE.test(date) || !ID_RE.test(carId)) return fail(env, 400, 'วันที่หรือรหัสรถไม่ถูกต้อง');
          await env.BUCKET.delete('data/records/' + date.slice(0, 7) + '/' + date + '_' + carId + (seg[3] === 'in' ? '_in' : '') + '.json');
          return json(env, { ok: true });
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
