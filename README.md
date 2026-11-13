# Smart Sleep Cycle & Wake-up Assistant (IoT Monorepo)

ระบบตรวจจับระยะการนอนหลับด้วย On-Device AI บนบอร์ด ESP32-S3 (FreeRTOS) รับข้อมูลไร้สายผ่าน ESP-NOW จากโหนดเซนเซอร์ และแสดงผล/สั่งงานแบบเรียลไทม์ผ่าน Next.js Web Dashboard ด้วยโปรโตคอล MQTT

## โครงสร้างโปรเจกต์ (Monorepo Structure)
* `firmware-gateway/` - โค้ดบอร์ดแม่ **ESP32-S3** (FreeRTOS 5 Tasks, Hardware Interrupt, ESP-NOW Receiver, MQTT Client)
* `firmware-nodes/` - โค้ดบอร์ดลูก **ESP32** (อ่านค่าการขยับตัว MPU6050 และชีพจร KY-039 ส่งผ่าน ESP-NOW)
* `web-dashboard/` - หน้าเว็บแดชบอร์ด **Next.js + Tailwind CSS** เชื่อมต่อผ่าน `wss://broker.hivemq.com:8884/mqtt`

---

## ตารางการต่อสายไฟสำหรับบอร์ดจริง (Hardware Pinout)

### 1. บอร์ดแม่: Gateway (`ESP32-S3`)
| อุปกรณ์ / โมดูล | ขาของโมดูล | ขาบนบอร์ด ESP32-S3 | หมายเหตุ |
| :--- | :--- | :--- | :--- |
| **ปุ่มกดหยุดปลุก (KY-004)** | Signal (S), GND | **GPIO 4**, GND | ใช้กับ Hardware Interrupt (ISR) |
| **ไฟปลุกจำลองแสงอาทิตย์ (KY-009)** | R (หรือ S), GND | **GPIO 5**, GND | หรี่ไฟด้วยสัญญาณ PWM |
| **โมดูลรีเลย์พัดลม/แอร์ (KY-019)** | IN, VCC, GND | **GPIO 6**, **5V**, GND | รีเลย์ควรใช้ไฟเลี้ยงจากขา 5V (VBUS) |
| **เซนเซอร์วัดแสง (LDR Module)** | AO, VCC, GND | **GPIO 7**, 3V3, GND | ใช้ขา ADC1 (GPIO 1-10) เพื่อไม่ให้ชนกับ Wi-Fi |
| **เซนเซอร์วัดเสียง (KY-037)** | AO, VCC, GND | **GPIO 8**, 3V3, GND | ใช้ขา ADC1 (GPIO 1-10) |
| **วัดอุณหภูมิ/ความชื้น (KY-015)** | Signal (S), VCC, GND | **GPIO 15**, 3V3, GND | โมดูล DHT11 |

### 2. บอร์ดลูก: Sensor Node (`ESP32 Dev Module`)
| อุปกรณ์ / โมดูล | ขาของโมดูล | ขาบนบอร์ด ESP32 | หมายเหตุ |
| :--- | :--- | :--- | :--- |
| **วัดความเร่ง/การพลิกตัว (MPU6050)** | SDA, SCL, VCC, GND | **GPIO 21**, **GPIO 22**, 3V3, GND | เชื่อมต่อแบบ I2C |
| **วัดอัตราการเต้นหัวใจ (KY-039)** | Signal (S), VCC, GND | **GPIO 34**, 3V3, GND | อ่านค่า Analog |
| **เซนเซอร์ตรวจจับคนบนเตียง** | ขาที่ 1, ขาที่ 2 | **GPIO 35**, GND | ตั้งโหมด `INPUT_PULLUP` |

---

## วิธีสลับจากโหมดจำลอง Wokwi เป็นบอร์ดจริง
1. เปิดไฟล์ `firmware-gateway/src/main.cpp`
2. แก้บรรทัด `#define USE_WOKWI_SIMULATION true` ให้เป็น **`false`**
3. ใส่ชื่อ Wi-Fi และรหัสผ่านจริงในตัวแปร `WIFI_SSID` และ `WIFI_PASS` แล้วกด Upload ลงบอร์ด ESP32-S3