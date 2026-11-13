#include <Arduino.h>

// กำหนดขา Pin (เปลี่ยนตามการต่อจริงภายหลัง)
#define STOP_BUTTON_PIN 4   // KY-004 ปุ่มหยุดฉุกเฉิน/ปิดปลุก
#define WAKE_LED_PIN    5   // KY-009 ไฟปลุกจำลองแสงอาทิตย์ (PWM)
#define RELAY_PIN       6   // KY-019 รีเลย์เปิด-ปิดพัดลม

// 1. สร้างโครงสร้างข้อมูลสำหรับส่งข้าม Task ผ่าน Queue
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

// 2. ประกาศ Queue และ Semaphore สำหรับสื่อสารระหว่าง Task
QueueHandle_t envQueue;
QueueHandle_t nodeQueue;
QueueHandle_t cloudQueue;
SemaphoreHandle_t stopAlarmSemaphore;

volatile bool isAlarmActive = false;

// ==========================================
// เป้าหมาย E2: Interrupt Service Routine (ISR)
// ==========================================
void IRAM_ATTR onStopButtonPressed() {
    BaseType_t xHigherPriorityTaskWoken = pdFALSE;
    xSemaphoreGiveFromISR(stopAlarmSemaphore, &xHigherPriorityTaskWoken);
    if (xHigherPriorityTaskWoken) {
        portYIELD_FROM_ISR();
    }
}

// ==========================================
// เป้าหมาย E1: แบ่งการทำงานเป็น 5 Tasks
// ==========================================

// Task 1: อ่านเซนเซอร์สภาพแวดล้อมบน Gateway (Priority 5)
void TaskReadEnvSensors(void *pvParameters) {
    EnvData env;
    for (;;) {
        env.temp = 24.5 + (random(-10, 10) * 0.1);
        env.hum = 60.0;
        env.light = analogRead(34);
        env.noise = 40;

        xQueueOverwrite(envQueue, &env);
        vTaskDelay(pdMS_TO_TICKS(2000));
    }
}

// Task 2: รับข้อมูลจาก Sensor Nodes ผ่าน ESP-NOW (Priority 4)
void TaskEspNowReceiver(void *pvParameters) {
    NodeData node;
    for (;;) {
        node.hr = random(55, 75);
        node.spo2 = random(95, 100);
        node.accel = random(1, 20) * 0.1;
        node.on_bed = true;

        xQueueOverwrite(nodeQueue, &node);
        vTaskDelay(pdMS_TO_TICKS(1000));
    }
}

// Task 3: ประมวลผล On-device AI (Priority 3)
void TaskAIProcessing(void *pvParameters) {
    EnvData env;
    NodeData node;
    for (;;) {
        if (xQueuePeek(envQueue, &env, 0) && xQueuePeek(nodeQueue, &node, 0)) {
            if (node.accel < 0.5 && node.hr < 65) {
                Serial.println("[AI] State: DEEP_SLEEP -> ลดพัดลม");
                digitalWrite(RELAY_PIN, LOW);
            } else {
                Serial.println("[AI] State: LIGHT_SLEEP -> เตรียมปลุก");
                isAlarmActive = true;
            }
            xQueueSend(cloudQueue, &node, 0);
        }
        vTaskDelay(pdMS_TO_TICKS(5000));
    }
}

// Task 4: ควบคุม Actuator และ ISR (Priority 2)
void TaskActuatorControl(void *pvParameters) {
    int pwmBrightness = 0;
    for (;;) {
        if (xSemaphoreTake(stopAlarmSemaphore, pdMS_TO_TICKS(100)) == pdTRUE) {
            Serial.println("[ISR] กดปุ่มหยุด!");
            isAlarmActive = false;
            pwmBrightness = 0;
            analogWrite(WAKE_LED_PIN, 0);
        }

        if (isAlarmActive && pwmBrightness < 255) {
            pwmBrightness += 5;
            analogWrite(WAKE_LED_PIN, pwmBrightness);
        }
        vTaskDelay(pdMS_TO_TICKS(500));
    }
}

// Task 5: ส่งข้อมูลขึ้น Cloud ผ่าน MQTT (Priority 1)
void TaskCloudPublish(void *pvParameters) {
    NodeData dataToSend;
    for (;;) {
        if (xQueueReceive(cloudQueue, &dataToSend, portMAX_DELAY) == pdTRUE) {
            Serial.printf("[Cloud] ส่งข้อมูล -> HR: %.1f\n", dataToSend.hr);
        }
        vTaskDelay(pdMS_TO_TICKS(5000));
    }
}

void setup() {
    Serial.begin(115200);
    pinMode(STOP_BUTTON_PIN, INPUT_PULLUP);
    pinMode(WAKE_LED_PIN, OUTPUT);
    pinMode(RELAY_PIN, OUTPUT);

    envQueue = xQueueCreate(1, sizeof(EnvData));
    nodeQueue = xQueueCreate(1, sizeof(NodeData));
    cloudQueue = xQueueCreate(10, sizeof(NodeData));
    stopAlarmSemaphore = xSemaphoreCreateBinary();

    attachInterrupt(digitalPinToInterrupt(STOP_BUTTON_PIN), onStopButtonPressed, FALLING);

    xTaskCreate(TaskReadEnvSensors,  "EnvTask",      2048, NULL, 5, NULL);
    xTaskCreate(TaskEspNowReceiver,  "EspNowTask",   2048, NULL, 4, NULL);
    xTaskCreate(TaskAIProcessing,    "AITask",       4096, NULL, 3, NULL);
    xTaskCreate(TaskActuatorControl, "ActuatorTask", 2048, NULL, 2, NULL);
    xTaskCreate(TaskCloudPublish,    "CloudTask",    4096, NULL, 1, NULL);
}

void loop() {
    // ปล่อยว่างไว้
}