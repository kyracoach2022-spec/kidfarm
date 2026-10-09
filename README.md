# KidFarm — Zana Little Garden

เกมปลูกผัก เลี้ยงปลา แจกเป็นของแถมให้ลูกค้าที่ซื้อสินค้า ZANA ลูกค้าลงทะเบียนด้วยรหัสเข้าใช้งาน
เล่นถึงเลเวลที่กำหนดแล้วได้คูปองส่วนลดกลับมาซื้อซ้ำ

- เกม: https://kidfarm.zanadynasty.com
- หลังร้าน (พนักงาน): https://kidfarm.zanadynasty.com/staff — ใช้รหัสพนักงาน (ขอจากเจ้าของร้าน ไม่เก็บใน repo)

## โครงสร้าง

| โฟลเดอร์ | คืออะไร | ขึ้นที่ไหน |
|---|---|---|
| `site/index.html` | ตัวเกม (หน้าเดียว ไม่ต้อง build) | Netlify site `kyrakidsquiz` |
| `site/staff.html` | หน้าพนักงาน: สร้างรหัสเข้าใช้งาน, ตรวจ/ใช้คูปอง, รายชื่อผู้เล่น, CSV | Netlify |
| `site/_redirects`, `site/_headers` | `/staff` → staff.html, กันหน้า staff ไม่ให้ติด Google | Netlify |
| `supabase/functions/garden/index.ts` | API ของเกม (ลงทะเบียน, บันทึกความคืบหน้า, ออกคูปอง, หลังร้าน) | Supabase Edge Function `garden` ในโปรเจกต์ ZANA DYNASTY COS |
| `supabase/migrations/*.sql` | ตารางผู้เล่น คูปอง รหัสเข้าใช้งาน และขั้นรางวัล | ฐานข้อมูล ZANA DYNASTY COS (รันแล้ว) |

หน้าเว็บไม่มีคีย์ Supabase ใดๆ — คุยกับ Edge Function อย่างเดียว ตาราง `garden_*` เปิด RLS และไม่มี policy
มีแต่ Edge Function (service role) ที่อ่าน/เขียนได้

## Deploy

**เว็บ (Netlify):** เชื่อม repo นี้กับ site `kyrakidsquiz` ครั้งเดียว (Site configuration → Build & deploy →
Link repository) แล้วทุกครั้งที่ push เข้า `main` จะขึ้นเว็บอัตโนมัติ (`netlify.toml` ตั้ง publish = `site`)
หรือจะลากโฟลเดอร์ `site/` ไปวางในหน้า Deploys ก็ได้

**API (Supabase):** แก้ `supabase/functions/garden/index.ts` แล้ว deploy ด้วย
`supabase functions deploy garden --project-ref gxycxjksrzjzxzgbblup --no-verify-jwt`

## ตั้งค่าที่แก้ได้เองใน Supabase Table Editor

- `garden_milestones` — เลเวลที่ได้คูปอง, ข้อความส่วนลด, เวลาขั้นต่ำหลังลงทะเบียน (กันโกง), อายุคูปอง (วัน)
- `garden_config.staff_pin_hash` — SHA-256 (hex) ของรหัสพนักงานตัวพิมพ์ใหญ่ เปลี่ยนรหัสได้ที่นี่

## โดเมน

`kidfarm.zanadynasty.com` → DNS `CNAME kidfarm kyrakidsquiz.netlify.app` + Add domain ใน Netlify
ลิงก์และ QR ในหน้า staff สร้างจากโดเมนที่เปิดอยู่ ไม่ต้องแก้โค้ดเมื่อเปลี่ยนโดเมน
