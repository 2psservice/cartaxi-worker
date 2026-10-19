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
        if (!(await hmacOk(env, body, req.headers.get('x-line-signature') || ''))) return fail(env, 401, 'bad signature');
        let j = {}; try { j = JSON.parse(body); } catch {}
        for (const ev of j.events || []) {
          const src = ev.source || {};
          if (src.type === 'group' && src.groupId) await putJson(env, 'data/line/target.json', { id: src.groupId, type: 'group', at: new Date().toISOString() });
        }
        return json(env, { ok: true });
      }

      if (!path.startsWith('/api/')) return fail(env, 404, 'ไม่พบหน้า');
      const origin = url.origin;

      const role = roleOf(req, env);
      if (!role) return fail(env, 401, 'รหัสแอปไม่ถูกต้อง');
      const seg = path.split('/').slice(2); // หลัง /api/

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
          if (!prevT && env.LINE_TOKEN) ctx.waitUntil(notifyRepair(env, t, origin).catch(() => {}));
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
          if (env.LINE_TOKEN) ctx.waitUntil(notifyRecord(env, r, existed, origin).catch(() => {}));
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
