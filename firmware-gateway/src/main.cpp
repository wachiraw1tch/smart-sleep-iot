#include <Arduino.h>
#include <WiFi.h>
#include <esp_now.h>
#include <PubSubClient.h>
#include <ArduinoJson.h>
#include <DHT.h>

// ==========================================
// 1. ตั้งค่า Wi-Fi & MQTT (สลับโหมด Wokwi / บอร์ดจริง ตรงนี้)
// ==========================================
#define USE_WOKWI_SIMULATION true  // <--- เปลี่ยนเป็น false เมื่อเอาโค้ดลงบอร์ดจริง!

#if USE_WOKWI_SIMULATION
  const char* WIFI_SSID = "Wokwi-GUEST";
  const char* WIFI_PASS = "";
#else
  const char* WIFI_SSID = "ใส่ชื่อ_WiFi_หอพักหรือมือถือ";
  const char* WIFI_PASS = "ใส่รหัสผ่าน_WiFi";
#endif

const char* MQTT_BROKER = "broker.hivemq.com";
const int   MQTT_PORT   = 1883;
const char* TOPIC_TELEMETRY = "smartsleep/wachiraw1tch/telemetry"; // ส่งค่าขึ้นเว็บ
const char* TOPIC_COMMAND   = "smartsleep/wachiraw1tch/command";   // รับคำสั่งจากเว็บ

// ==========================================
// 2. กำหนดขา Pin สำหรับต่อวงจรจริง (ESP32-S3)
// ==========================================
#define STOP_BUTTON_PIN 4   // KY-004 ปุ่มหยุดปลุก (ต่อขา Signal เข้า GPIO 4)
#define WAKE_LED_PIN    5   // KY-009 ไฟปลุก PWM (ต่อขา R หรือ S เข้า GPIO 5)
#define RELAY_PIN       6   // KY-019 รีเลย์พัดลม (ต่อขา IN เข้า GPIO 6)
#define LDR_PIN         7   // LDR วัดแสง (ESP32-S3 ต้องใช้ ADC1: GPIO 1-10 เท่านั้น ห้ามใช้ขา 34!)
#define SOUND_PIN       8   // KY-037 วัดเสียง (ต่อขา AO เข้า GPIO 8)
#define DHT_PIN         15  // KY-015 วัดอุณหภูมิ/ความชื้น (ต่อขา Signal เข้า GPIO 15)
#define DHT_TYPE        DHT11

DHT dht(DHT_PIN, DHT_TYPE);
WiFiClient espClient;
PubSubClient mqttClient(espClient);

// โครงสร้างข้อมูล
struct EnvData {
    float temp;
    float hum;
    int light;
    int noise;
};

struct NodeData {
    float hr;
    float spo2;
    float accel;
    bool on_bed;
};

QueueHandle_t envQueue;
QueueHandle_t nodeQueue;
SemaphoreHandle_t stopAlarmSemaphore;

volatile bool isAlarmActive = false;
volatile bool isFanOn = false;
volatile unsigned long lastEspNowRecv = 0;
String currentSleepStage = "DEEP_SLEEP";

// ==========================================
// ISR: กดปุ่มหยุดปลุกที่ตัวบอร์ด (Hardware Interrupt)
// ==========================================
void IRAM_ATTR onStopButtonPressed() {
    BaseType_t xHigherPriorityTaskWoken = pdFALSE;
    xSemaphoreGiveFromISR(stopAlarmSemaphore, &xHigherPriorityTaskWoken);
    if (xHigherPriorityTaskWoken) {
        portYIELD_FROM_ISR();
    }
}

// ==========================================
// Callback รับข้อมูลจริงจากบอร์ดลูกผ่าน ESP-NOW
// ==========================================
void OnEspNowDataRecv(const uint8_t * mac, const uint8_t *incomingData, int len) {
    if (len == sizeof(NodeData)) {
        NodeData recvNode;
        memcpy(&recvNode, incomingData, sizeof(NodeData));
        xQueueOverwriteFromISR(nodeQueue, &recvNode, NULL);
        lastEspNowRecv = millis();
    }
}

// ==========================================
// Callback รับคำสั่งกดปุ่มจากหน้าเว็บ Next.js ผ่าน MQTT
// ==========================================
void onMqttMessage(char* topic, byte* payload, unsigned int length) {
    JsonDocument doc;
    deserializeJson(doc, payload, length);

    if (doc["action"] == "STOP_ALARM") {
        Serial.println("[MQTT Cmd] สั่งปิดปลุกจากหน้าเว็บ!");
        xSemaphoreGive(stopAlarmSemaphore);
    } 
    else if (doc["action"] == "TOGGLE_FAN") {
        isFanOn = doc["value"];
        digitalWrite(RELAY_PIN, isFanOn ? HIGH : LOW);
        Serial.printf("[MQTT Cmd] สั่งพัดลม: %s\n", isFanOn ? "ON" : "OFF");
    }
}

// ==========================================
// Task 1: อ่านเซนเซอร์สภาพแวดล้อมบน Gateway (Priority 5)
// ==========================================
void TaskReadEnvSensors(void *pvParameters) {
    EnvData env;
    dht.begin();
    for (;;) {
        float t = dht.readTemperature();
        float h = dht.readHumidity();

        // ถ้าต่อเซนเซอร์จริงและอ่านค่าได้ ให้ใช้ค่าจริง ถ้าไม่ได้ต่อให้ใช้ค่าจำลอง
        env.temp  = isnan(t) ? (24.5 + random(-5, 5) * 0.1) : t;
        env.hum   = isnan(h) ? 58.0 : h;
        env.light = map(analogRead(LDR_PIN), 0, 4095, 10, 300);
        env.noise = map(analogRead(SOUND_PIN), 0, 4095, 30, 75);

        xQueueOverwrite(envQueue, &env);
        vTaskDelay(pdMS_TO_TICKS(2000));
    }
}

// ==========================================
// Task 2: จัดการข้อมูล Node (รับจริง + Fallback จำลองเมื่อทดสอบเดี่ยว) (Priority 4)
// ==========================================
void TaskEspNowReceiver(void *pvParameters) {
    NodeData node;
    for (;;) {
        // ถ้าไม่มีสัญญาณ ESP-NOW จากบอร์ดลูกเกิน 5 วินาที ให้สร้างค่าจำลองขึ้นมาแทน
        if (millis() - lastEspNowRecv > 5000) {
            node.hr = random(56, 74);
            node.spo2 = 98.0;
            node.accel = random(1, 15) * 0.05;
            node.on_bed = true;
            xQueueOverwrite(nodeQueue, &node);
        }
        vTaskDelay(pdMS_TO_TICKS(2000));
    }
}

// ==========================================
// Task 3: ประมวลผล On-device AI แยกสถานะการนอน (Priority 3)
// ==========================================
void TaskAIProcessing(void *pvParameters) {
    EnvData env;
    NodeData node;
    for (;;) {
        if (xQueuePeek(envQueue, &env, 0) && xQueuePeek(nodeQueue, &node, 0)) {
            if (!node.on_bed) {
                currentSleepStage = "AWAKE";
            } else if (node.accel < 0.3 && node.hr < 65) {
                currentSleepStage = "DEEP_SLEEP";
                isFanOn = false;
                digitalWrite(RELAY_PIN, LOW);
            } else {
                currentSleepStage = "LIGHT_SLEEP";
                isAlarmActive = true;
            }
            Serial.printf("[AI] Stage: %s | HR: %.0f | Accel: %.2f\n", 
                          currentSleepStage.c_str(), node.hr, node.accel);
        }
        vTaskDelay(pdMS_TO_TICKS(4000));
    }
}

// ==========================================
// Task 4: ควบคุมไฟปลุก PWM และปุ่มกดหยุด ISR (Priority 2)
// ==========================================
void TaskActuatorControl(void *pvParameters) {
    int pwmBrightness = 0;
    for (;;) {
        if (xSemaphoreTake(stopAlarmSemaphore, pdMS_TO_TICKS(100)) == pdTRUE) {
            Serial.println("[Actuator] หยุดการปลุกและปิดไฟ LED!");
            isAlarmActive = false;
            pwmBrightness = 0;
            analogWrite(WAKE_LED_PIN, 0);
        }

        if (isAlarmActive && pwmBrightness < 255) {
            pwmBrightness = min(255, pwmBrightness + 15);
            analogWrite(WAKE_LED_PIN, pwmBrightness);
        }
        vTaskDelay(pdMS_TO_TICKS(500));
    }
}

// ==========================================
// Task 5: ส่งข้อมูลขึ้น Web Dashboard ผ่าน MQTT (Priority 1)
// ==========================================
void TaskCloudPublish(void *pvParameters) {
    WiFi.mode(WIFI_AP_STA); // เปิดทั้งโหมดรับ ESP-NOW และต่อ Wi-Fi บ้านพร้อมกัน
    WiFi.begin(WIFI_SSID, WIFI_PASS);
    Serial.print("[WiFi] Connecting");
    while (WiFi.status() != WL_CONNECTED) {
        vTaskDelay(pdMS_TO_TICKS(500));
        Serial.print(".");
    }
    Serial.println("\n[WiFi] Connected!");

    if (esp_now_init() == ESP_OK) {
        esp_now_register_recv_cb(esp_now_recv_cb_t(OnEspNowDataRecv));
    }

    mqttClient.setServer(MQTT_BROKER, MQTT_PORT);
    mqttClient.setCallback(onMqttMessage);

    EnvData env;
    NodeData node;

    for (;;) {
        if (!mqttClient.connected()) {
            String clientId = "ESP32S3-Gateway-" + String(random(1000, 9999));
            if (mqttClient.connect(clientId.c_str())) {
                Serial.println("[MQTT] Connected to HiveMQ Broker!");
                mqttClient.subscribe(TOPIC_COMMAND);
            }
        }
        mqttClient.loop();

        if (xQueuePeek(envQueue, &env, 0) && xQueuePeek(nodeQueue, &node, 0)) {
            JsonDocument doc;
            doc["sleepStage"] = currentSleepStage;
            doc["hr"]         = (int)node.hr;
            doc["spo2"]       = (int)node.spo2;
            doc["movement"]   = serialized(String(node.accel, 2));
            doc["onBed"]      = node.on_bed;
            doc["temp"]       = serialized(String(env.temp, 1));
            doc["humidity"]   = (int)env.hum;
            doc["light"]      = env.light;
            doc["noise"]      = env.noise;
            doc["pwmOn"]      = isAlarmActive;
            doc["fanOn"]      = isFanOn;

            char buffer[256];
            serializeJson(doc, buffer);
            mqttClient.publish(TOPIC_TELEMETRY, buffer);
            Serial.printf("[MQTT Sent] %s\n", buffer);
        }
        vTaskDelay(pdMS_TO_TICKS(3000));
    }
}

void setup() {
    Serial.begin(115200);
    pinMode(STOP_BUTTON_PIN, INPUT_PULLUP);
    pinMode(WAKE_LED_PIN, OUTPUT);
    pinMode(RELAY_PIN, OUTPUT);

    envQueue = xQueueCreate(1, sizeof(EnvData));
    nodeQueue = xQueueCreate(1, sizeof(NodeData));
    stopAlarmSemaphore = xSemaphoreCreateBinary();

    attachInterrupt(digitalPinToInterrupt(STOP_BUTTON_PIN), onStopButtonPressed, FALLING);

    xTaskCreate(TaskReadEnvSensors,  "EnvTask",      3072, NULL, 5, NULL);
    xTaskCreate(TaskEspNowReceiver,  "EspNowTask",   2048, NULL, 4, NULL);
    xTaskCreate(TaskAIProcessing,    "AITask",       3072, NULL, 3, NULL);
    xTaskCreate(TaskActuatorControl, "ActuatorTask", 2048, NULL, 2, NULL);
    xTaskCreate(TaskCloudPublish,    "CloudTask",    6144, NULL, 1, NULL);
}

void loop() {}