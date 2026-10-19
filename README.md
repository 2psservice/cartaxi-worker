# cartaxi-api — Fleet Daily Check

Cloudflare Worker ที่เก็บเลขไมล์ ระดับน้ำมัน งานซ่อม และรูป ของแอป **Fleet Daily Check** ลงใน R2 bucket `cartaxi`

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/2psservice/cartaxi-worker)

## ติดตั้งด้วยปุ่มเดียว

1. กดปุ่ม **Deploy to Cloudflare** ด้านบน แล้วเข้าสู่ระบบ Cloudflare และ GitHub
2. ช่อง R2 bucket (`BUCKET`) ให้ใช้ชื่อ **cartaxi** (bucket เดิม)
3. ตั้งรหัส 2 ตัว
   - `APP_KEY` = รหัสคนขับ
   - `ADMIN_KEY` = รหัสแอดมิน (ต้องไม่ซ้ำกับรหัสคนขับ)
4. กด **Create and deploy** รอประมาณ 1 นาที จะได้ที่อยู่แบบ `https://cartaxi-api.<บัญชี>.workers.dev`
5. ทดสอบ: เปิด `https://cartaxi-api.<บัญชี>.workers.dev/api/ping` ต้องขึ้น `รหัสแอปไม่ถูกต้อง` (แปลว่า Worker ทำงานแล้ว)
6. เปิด `Fleet_Daily_Check.html` → ปุ่มคลาวด์มุมขวาบน → ใส่ที่อยู่ Worker + รหัส → **บันทึกและเชื่อมต่อ**

## ข้อมูลใน bucket

| ที่เก็บ | เนื้อหา |
|---|---|
| `data/cars.json` | รายการรถ |
| `data/records/<YYYY-MM>/<วันที่>_<รหัสรถ>.json` | เลขไมล์/น้ำมัน ขาไป |
| `data/records/<YYYY-MM>/<วันที่>_<รหัสรถ>_in.json` | เลขไมล์/น้ำมัน ขากลับ |
| `data/repairs/<รหัสงาน>.json` | งานซ่อม |
| `photos/<YYYY-MM>/<ชื่อสุ่ม>.jpg` | รูปหน้าปัด บิล รูปอาการซ่อม |

## สิทธิ์

- **ทุกคน (ไม่ต้องใส่รหัส)**: เปิดลิงก์แล้วใช้ได้เลย ดูข้อมูล, ส่งเลขไมล์ + รูป, เพิ่ม/แก้/ลบรถ, แจ้งซ่อมและเปลี่ยนสถานะซ่อม
  (ถ้าอยากบังคับใส่รหัส ตั้งตัวแปร `REQUIRE_APP_KEY` = `true` แล้วคนขับใช้ `APP_KEY`)
- **หน้าแอดมินในแอป**: ต้องใส่รหัส 8 หลัก (ตั้งไว้ในตัวแปร `ADMIN_PIN` ใน `public/index.html`) ก่อนเข้า จำไว้จนปิดแอป/แท็บ
- **`ADMIN_KEY` ของ Worker**: สิทธิ์เท่ากับทุกคน (ไม่ต้องใช้แล้ว)

รหัสเก็บเป็น Secret ใน Cloudflare ไม่อยู่ในโค้ดนี้

## API

| คำสั่ง | สิทธิ์ |
|---|---|
| `GET /api/ping` | ทุกคนที่มีรหัส |
| `GET /api/cars` · `PUT /api/cars` | ทุกคน |
| `GET /api/records?month=YYYY-MM` · `PUT /api/records/<date>/<carId>` (ขาไป) · `PUT /api/records/<date>/<carId>/in` (ขากลับ) | ทุกคน |
| `GET /api/repairs` · `PUT /api/repairs/<id>` | ทุกคน (เปิดงาน + เปลี่ยนสถานะ) |
| `PUT /api/photos/<YYYY-MM>/<name>.jpg` | ทุกคน (JPEG ≤ 3 MB) |
| `GET /photos/<YYYY-MM>/<name>.jpg` | สาธารณะ (ชื่อไฟล์สุ่ม) |

## แจ้งเตือนเข้า LINE (ขาไป / ขากลับ / แจ้งซ่อม)

ส่งการ์ด (Flex) เข้ากลุ่ม LINE ทุกครั้งที่คนขับส่งขาไป ขากลับ หรือแจ้งซ่อมใหม่ ผ่าน LINE Official Account (Messaging API)

1. LINE Developers → Messaging API channel → ออก **Channel access token (long-lived)**
2. Cloudflare → Workers → cartaxi-api → Settings → Variables and Secrets → เพิ่ม Secret `LINE_TOKEN`
3. บอกว่าจะส่งไปที่ไหน เลือกอย่างใดอย่างหนึ่ง
   - ตั้ง Secret `LINE_TO` = groupId (หรือ userId หลายค่า คั่นด้วย `,`)
   - หรือ ตั้ง Webhook URL ของ OA เป็น `https://<worker>/line/webhook` (+ Secret `LINE_SECRET` = Channel secret) แล้วเชิญบอทเข้ากลุ่ม ระบบจำ groupId ให้เอง
4. หน้าแอดมิน → ปุ่ม **ทดสอบแจ้งเตือน LINE**

ข้อความ push เข้ากลุ่มนับโควตาตามจำนวนสมาชิกในกลุ่ม
