/**
 * Fleet Daily Check — Cloudflare Worker สำหรับเก็บข้อมูลและรูปใน R2 (bucket: cartaxi)
 *
 * โครงสร้างไฟล์ใน R2
 *   data/cars.json                          รายการรถทั้งหมด
 *   data/repairs/<id>.json                  งานซ่อม 1 ไฟล์ต่อ 1 งาน
 *   data/records/<YYYY-MM>/<date>_<carId>.json   เลขไมล์/น้ำมัน 1 ไฟล์ต่อรถ 1 คันต่อวัน
 *   photos/<YYYY-MM>/<ชื่อไฟล์>.jpg          รูปหน้าปัด / บิล / รูปอาการซ่อม
 *
 * สิทธิ์ (ส่งรหัสใน header X-App-Key)
 *   (ไม่ใส่รหัส) = คนขับ   : อ่านข้อมูล, ส่งเลขไมล์, แจ้งซ่อมใหม่, อัปโหลดรูป
 *   APP_KEY   = รหัสคนขับ  : สิทธิ์เดียวกับคนขับ (ใช้เมื่อตั้ง REQUIRE_APP_KEY = "true")
 *   ADMIN_KEY = รหัสแอดมิน : ทำได้ทุกอย่าง + แก้รายการรถ + เปลี่ยนสถานะซ่อม
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

export default {
  async fetch(req, env) {
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

      if (!path.startsWith('/api/')) return fail(env, 404, 'ไม่พบหน้า');

      const role = roleOf(req, env);
      if (!role) return fail(env, 401, 'รหัสแอปไม่ถูกต้อง');
      const seg = path.split('/').slice(2); // หลัง /api/

      // GET /api/ping
      if (m === 'GET' && seg[0] === 'ping') return json(env, { ok: true, role, time: new Date().toISOString() });

      // ---------- รถ ----------
      if (seg[0] === 'cars' && seg.length === 1) {
        if (m === 'GET') return json(env, await getJson(env, 'data/cars.json', []));
        if (m === 'PUT') {
          if (role !== 'admin') return fail(env, 403, 'ต้องใช้รหัสแอดมิน');
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
          if (role !== 'admin') {
            // คนขับเปิดงานใหม่ได้เท่านั้น (สถานะ "แจ้งซ่อม") แก้งานที่มีอยู่แล้วไม่ได้
            if (await env.BUCKET.head(key)) return fail(env, 403, 'เปลี่ยนสถานะซ่อมได้เฉพาะแอดมิน');
            if (t.status !== 'reported') return fail(env, 403, 'คนขับแจ้งซ่อมได้เท่านั้น');
          }
          await putJson(env, key, t);
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
        if (m === 'PUT' && seg.length === 3) {
          const [, date, carId] = seg;
          if (!DATE_RE.test(date) || !ID_RE.test(carId)) return fail(env, 400, 'วันที่หรือรหัสรถไม่ถูกต้อง');
          const r = await readJson(req, env);
          if (!r || r.date !== date || r.carId !== carId) return fail(env, 400, 'ข้อมูลไม่ตรงกับวันที่/รถ');
          if (typeof r.odo !== 'number' || r.odo < 0) return fail(env, 400, 'เลขไมล์ไม่ถูกต้อง');
          if (String(r.photoOdo || '').startsWith('data:') || String(r.photoBill || '').startsWith('data:')) return fail(env, 400, 'ต้องอัปโหลดรูปก่อน');
          await putJson(env, 'data/records/' + date.slice(0, 7) + '/' + date + '_' + carId + '.json', r);
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
