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
| `data/records/<YYYY-MM>/<วันที่>_<รหัสรถ>.json` | เลขไมล์/น้ำมัน รถ 1 คัน 1 วัน |
| `data/repairs/<รหัสงาน>.json` | งานซ่อม |
| `photos/<YYYY-MM>/<ชื่อสุ่ม>.jpg` | รูปหน้าปัด บิล รูปอาการซ่อม |

## สิทธิ์

- **คนขับ (`APP_KEY`)**: ดูข้อมูล, ส่งเลขไมล์ + รูป, แจ้งซ่อมใหม่
- **แอดมิน (`ADMIN_KEY`)**: ทำได้ทุกอย่าง + เปลี่ยนสถานะซ่อม + แก้รายการรถ

รหัสเก็บเป็น Secret ใน Cloudflare ไม่อยู่ในโค้ดนี้

## API

| คำสั่ง | สิทธิ์ |
|---|---|
| `GET /api/ping` | ทุกคนที่มีรหัส |
| `GET /api/cars` · `PUT /api/cars` | อ่าน: ทุกคน · เขียน: แอดมิน |
| `GET /api/records?month=YYYY-MM` · `PUT /api/records/<date>/<carId>` | ทุกคน |
| `GET /api/repairs` · `PUT /api/repairs/<id>` | คนขับเปิดงานใหม่ได้เท่านั้น |
| `PUT /api/photos/<YYYY-MM>/<name>.jpg` | ทุกคน (JPEG ≤ 3 MB) |
| `GET /photos/<YYYY-MM>/<name>.jpg` | สาธารณะ (ชื่อไฟล์สุ่ม) |
