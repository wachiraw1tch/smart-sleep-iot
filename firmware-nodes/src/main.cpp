#include <Arduino.h>
#include <WiFi.h>
#include <esp_now.h>
#include <Wire.h>
#include <Adafruit_MPU6050.h>
#include <Adafruit_Sensor.h>

// กำหนดขา Pin สำหรับเซนเซอร์บน Node
#define PULSE_SENSOR_PIN 34  // KY-039 วัดชีพจร (Analog)
#define BED_SENSOR_PIN   35  // เซนเซอร์เช็กคนนอนบนเตียง (ใช้ปุ่มหรือ FSR จำลอง)

Adafruit_MPU6050 mpu;

// MAC Address ของ Gateway (ใช้ FF:FF:FF:FF:FF:FF เพื่อ Broadcast ส่งหาทุกบอร์ดได้ทันทีโดยไม่ต้องแก้เลข)
uint8_t gatewayAddress[] = {0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF};

// โครงสร้างข้อมูลตรงกับฝั่ง Gateway เป๊ะๆ
struct NodeData {
    float hr;
    float spo2;
    float accel;
    bool on_bed;
};

NodeData myData;
esp_now_peer_info_t peerInfo;

// Callback เมื่อส่งข้อมูลผ่าน ESP-NOW
void OnDataSent(const uint8_t *mac_addr, esp_now_send_status_t status) {
    Serial.print("[ESP-NOW] Send Status: ");
    Serial.println(status == ESP_NOW_SEND_SUCCESS ? "Delivery Success" : "Delivery Fail");
}

void setup() {
    Serial.begin(115200);
    pinMode(PULSE_SENSOR_PIN, INPUT);
    pinMode(BED_SENSOR_PIN, INPUT_PULLUP);

    // 1. เริ่มต้นการทำงาน MPU6050 (I2C: SDA=21, SCL=22)
    Wire.begin(21, 22);
    if (!mpu.begin()) {
        Serial.println("[Warning] ไม่พบเซนเซอร์ MPU6050! จะใช้ค่าจำลองแทน");
    } else {
        Serial.println("[MPU6050] Connected!");
        mpu.setAccelerometerRange(MPU6050_RANGE_4_G);
        mpu.setFilterBandwidth(MPU6050_BAND_21_HZ);
    }

    // 2. ตั้งค่า WiFi โหมด Station สำหรับ ESP-NOW
    WiFi.mode(WIFI_STA);
    if (esp_now_init() != ESP_OK) {
        Serial.println("[Error] Initializing ESP-NOW failed");
        return;
    }

    esp_now_register_send_cb(OnDataSent);

    // 3. ลงทะเบียน Gateway Peer
    memcpy(peerInfo.peer_addr, gatewayAddress, 6);
    peerInfo.channel = 0;  
    peerInfo.encrypt = false;
    
    if (esp_now_add_peer(&peerInfo) != ESP_OK) {
        Serial.println("[Error] Failed to add peer");
        return;
    }
}

void loop() {
    // 1. อ่านค่าความเร่งจาก MPU6050 เพื่อดูการพลิกตัว
    sensors_event_t a, g, temp;
    if (mpu.getAccelerometerSensor() != NULL) {
        mpu.getEvent(&a, &g, &temp);
        // คำนวณความแรงของการขยับตัว (หักลบแรงโน้มถ่วงโลก 9.8 m/s^2)
        float totalAccel = sqrt(a.acceleration.x * a.acceleration.x +
                                a.acceleration.y * a.acceleration.y +
                                a.acceleration.z * a.acceleration.z);
        myData.accel = abs(totalAccel - 9.8);
    } else {
        myData.accel = 0.2; // ค่าจำลองกรณีไม่ได้ต่อเซนเซอร์
    }

    // 2. อ่านค่าชีพจรจาก KY-039 (แปลงค่า Analog 0-4095 เป็นช่วง BPM 55-90)
    int rawPulse = analogRead(PULSE_SENSOR_PIN);
    myData.hr = map(rawPulse, 0, 4095, 55, 90);
    myData.spo2 = 98.0; // ค่าจำลองออกซิเจนในเลือด

    // 3. เช็กว่าอยู่บนเตียงหรือไม่ (กดปุ่ม = LOW = อยู่บนเตียง)
    myData.on_bed = (digitalRead(BED_SENSOR_PIN) == LOW);

    // 4. ส่งข้อมูลผ่าน ESP-NOW ไปให้ Gateway
    esp_err_t result = esp_now_send(gatewayAddress, (uint8_t *) &myData, sizeof(myData));

    Serial.printf("[Node] HR: %.1f BPM | Movement: %.2f m/s2 | OnBed: %s\n",
                  myData.hr, myData.accel, myData.on_bed ? "YES" : "NO");

    delay(2000); // ส่งข้อมูลทุกๆ 2 วินาที
}