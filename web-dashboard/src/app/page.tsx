"use client";

import React, { useState, useEffect } from "react";
import mqtt from "mqtt";
import { 
  Heart, Wind, Sun, Volume2, Moon, Bed, BellOff, 
  Fan, Activity, Wifi, Play, Pause 
} from "lucide-react";

interface SleepTelemetry {
  hr: number;
  spo2: number;
  accel: number;
  on_bed: boolean;
  temp: number;
  hum: number;
  light: number;
  noise: number;
  sleep_stage: "DEEP_SLEEP" | "LIGHT_SLEEP" | "AWAKE";
  alarm_active: boolean;
  fan_relay: boolean;
}

export default function SmartSleepDashboard() {
  const [mqttClient, setMqttClient] = useState<mqtt.MqttClient | null>(null);
  const [isConnected, setIsConnected] = useState(false);
  const [isDemoMode, setIsDemoMode] = useState(true);
  const [historyHR, setHistoryHR] = useState<number[]>([64, 63, 62, 60, 61, 59, 62, 65]);

  const [data, setData] = useState<SleepTelemetry>({
    hr: 62,
    spo2: 98,
    accel: 0.15,
    on_bed: true,
    temp: 24.5,
    hum: 58,
    light: 120,
    noise: 38,
    sleep_stage: "DEEP_SLEEP",
    alarm_active: false,
    fan_relay: true,
  });

  // 1. เชื่อมต่อ MQTT Broker (ผ่าน WebSockets)
  useEffect(() => {
    const client = mqtt.connect("wss://broker.emqx.io:8084/mqtt");

    client.on("connect", () => {
      setIsConnected(true);
      client.subscribe("smart-sleep/wachiraw1tch/telemetry");
    });

    client.on("message", (topic, message) => {
      if (topic === "smart-sleep/wachiraw1tch/telemetry") {
        try {
          const parsed = JSON.parse(message.toString());
          setIsDemoMode(false);
          setData((prev) => ({ ...prev, ...parsed }));
          if (parsed.hr) {
            setHistoryHR((prev) => [...prev.slice(-14), parsed.hr]);
          }
        } catch (e) {
          console.error("Invalid JSON from MQTT:", e);
        }
      }
    });

    setMqttClient(client);
    return () => {
      client.end();
    };
  }, []);

  // 2. โหมดจำลองข้อมูลอัตโนมัติ (ไว้พรีเซนต์งานตอนไม่ได้ต่อบอร์ดจริง)
  useEffect(() => {
    if (!isDemoMode) return;
    const interval = setInterval(() => {
      setData((prev) => {
        const newHr = Math.floor(56 + Math.random() * 18);
        const newAccel = Number((Math.random() * 0.8).toFixed(2));
        const stage =
          newAccel < 0.35 && newHr < 65
            ? "DEEP_SLEEP"
            : newAccel < 0.65
            ? "LIGHT_SLEEP"
            : "AWAKE";

        setHistoryHR((h) => [...h.slice(-14), newHr]);

        return {
          ...prev,
          hr: newHr,
          accel: newAccel,
          temp: Number((24.0 + Math.random() * 1.5).toFixed(1)),
          sleep_stage: stage,
          alarm_active: stage === "LIGHT_SLEEP" ? true : prev.alarm_active,
          fan_relay: stage !== "DEEP_SLEEP",
        };
      });
    }, 3000);

    return () => clearInterval(interval);
  }, [isDemoMode]);

  // 3. ฟังก์ชันส่งคำสั่งควบคุมกลับไปที่ ESP32-S3 Gateway
  const sendCommand = (cmd: string) => {
    if (mqttClient && isConnected) {
      mqttClient.publish("smart-sleep/wachiraw1tch/command", JSON.stringify({ action: cmd }));
    }
    if (cmd === "STOP_ALARM") {
      setData((prev) => ({ ...prev, alarm_active: false }));
    } else if (cmd === "TOGGLE_FAN") {
      setData((prev) => ({ ...prev, fan_relay: !prev.fan_relay }));
    }
  };

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 p-6 md:p-10 font-sans">
      <div className="max-w-6xl mx-auto space-y-8">
        
        {/* Header */}
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 border-b border-slate-800 pb-6">
          <div>
            <h1 className="text-2xl md:text-3xl font-bold flex items-center gap-3">
              <Moon className="text-indigo-400 w-8 h-8" />
              Smart Sleep Cycle & Wake-up Assistant
            </h1>
            <p className="text-slate-400 text-sm mt-1">
              ESP32-S3 Edge AI Gateway & ESP-NOW Sensor Network
            </p>
          </div>

          <div className="flex items-center gap-3">
            <button
              onClick={() => setIsDemoMode(!isDemoMode)}
              className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition ${
                isDemoMode
                  ? "bg-amber-500/20 text-amber-300 border border-amber-500/40"
                  : "bg-slate-800 text-slate-300 border border-slate-700"
              }`}
            >
              {isDemoMode ? <Pause className="w-4 h-4" /> : <Play className="w-4 h-4" />}
              {isDemoMode ? "Demo Simulation: ON" : "Demo Simulation: OFF"}
            </button>

            <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-slate-900 border border-slate-800 text-xs">
              <Wifi className={`w-4 h-4 ${isConnected ? "text-emerald-400" : "text-rose-400"}`} />
              <span>{isConnected ? "MQTT Connected" : "MQTT Offline"}</span>
            </div>
          </div>
        </div>

        {/* Status Banner */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
          <div className="md:col-span-2 bg-gradient-to-br from-indigo-950/60 to-slate-900 border border-indigo-500/30 rounded-2xl p-6 flex items-center justify-between">
            <div>
              <span className="text-xs uppercase tracking-wider text-indigo-300 font-semibold">
                On-Device AI Sleep Stage
              </span>
              <h2 className="text-3xl font-extrabold mt-2 tracking-tight">
                {data.sleep_stage === "DEEP_SLEEP" && "🌙 DEEP SLEEP (หลับลึก)"}
                {data.sleep_stage === "LIGHT_SLEEP" && "🌤️ LIGHT SLEEP (หลับตื้น - พร้อมปลุก)"}
                {data.sleep_stage === "AWAKE" && "👀 AWAKE (ตื่นนอน)"}
              </h2>
              <p className="text-slate-400 text-sm mt-2">
                Movement: <span className="text-slate-200 font-medium">{data.accel} m/s²</span> | 
                Bed Occupancy: <span className="text-emerald-400 font-medium">{data.on_bed ? "On Bed" : "Empty"}</span>
              </p>
            </div>
            <Bed className="w-16 h-16 text-indigo-400/40 hidden sm:block" />
          </div>

          {/* Actuator Controls (เป้าหมาย E2 & Smart Control) */}
          <div className="bg-slate-900 border border-slate-800 rounded-2xl p-6 flex flex-col justify-between space-y-4">
            <span className="text-xs uppercase tracking-wider text-slate-400 font-semibold">
              Gateway Actuators & Override
            </span>

            <div className="flex items-center justify-between">
              <span className="text-sm text-slate-300">Sunrise Wake-up Light</span>
              <span className={`px-2.5 py-1 rounded-full text-xs font-semibold ${
                data.alarm_active ? "bg-amber-500/20 text-amber-300" : "bg-slate-800 text-slate-400"
              }`}>
                {data.alarm_active ? "PWM DIMMING ON" : "STANDBY"}
              </span>
            </div>

            <div className="flex gap-3 pt-2">
              <button
                onClick={() => sendCommand("STOP_ALARM")}
                className="flex-1 bg-rose-600 hover:bg-rose-500 text-white font-medium py-2.5 px-4 rounded-xl flex items-center justify-center gap-2 text-sm transition"
              >
                <BellOff className="w-4 h-4" />
                Stop Alarm
              </button>

              <button
                onClick={() => sendCommand("TOGGLE_FAN")}
                className={`flex-1 font-medium py-2.5 px-4 rounded-xl flex items-center justify-center gap-2 text-sm border transition ${
                  data.fan_relay
                    ? "bg-emerald-600/20 border-emerald-500/40 text-emerald-300"
                    : "bg-slate-800 border-slate-700 text-slate-400"
                }`}
              >
                <Fan className="w-4 h-4" />
                {data.fan_relay ? "Fan: ON" : "Fan: OFF"}
              </button>
            </div>
          </div>
        </div>

        {/* Sensor Metrics Grid */}
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
          <div className="bg-slate-900 border border-slate-800 p-5 rounded-2xl">
            <div className="flex items-center justify-between text-slate-400 text-sm">
              <span>Heart Rate (KY-039)</span>
              <Heart className="w-5 h-5 text-rose-500" />
            </div>
            <div className="text-3xl font-bold mt-3">{data.hr} <span className="text-base font-normal text-slate-400">BPM</span></div>
            <div className="text-xs text-emerald-400 mt-2">SpO2: {data.spo2}%</div>
          </div>

          <div className="bg-slate-900 border border-slate-800 p-5 rounded-2xl">
            <div className="flex items-center justify-between text-slate-400 text-sm">
              <span>Room Temp (KY-015)</span>
              <Wind className="w-5 h-5 text-sky-400" />
            </div>
            <div className="text-3xl font-bold mt-3">{data.temp} <span className="text-base font-normal text-slate-400">°C</span></div>
            <div className="text-xs text-slate-400 mt-2">Humidity: {data.hum}%</div>
          </div>

          <div className="bg-slate-900 border border-slate-800 p-5 rounded-2xl">
            <div className="flex items-center justify-between text-slate-400 text-sm">
              <span>Ambient Light (LDR)</span>
              <Sun className="w-5 h-5 text-amber-400" />
            </div>
            <div className="text-3xl font-bold mt-3">{data.light} <span className="text-base font-normal text-slate-400">Lux</span></div>
            <div className="text-xs text-slate-400 mt-2">Optimal &lt; 150 Lux</div>
          </div>

          <div className="bg-slate-900 border border-slate-800 p-5 rounded-2xl">
            <div className="flex items-center justify-between text-slate-400 text-sm">
              <span>Noise Level (KY-037)</span>
              <Volume2 className="w-5 h-5 text-purple-400" />
            </div>
            <div className="text-3xl font-bold mt-3">{data.noise} <span className="text-base font-normal text-slate-400">dB</span></div>
            <div className="text-xs text-slate-400 mt-2">Quiet Environment</div>
          </div>
        </div>

        {/* Real-time Heart Rate Trend Bar Chart */}
        <div className="bg-slate-900 border border-slate-800 rounded-2xl p-6">
          <div className="flex items-center justify-between mb-6">
            <div className="flex items-center gap-2">
              <Activity className="w-5 h-5 text-rose-400" />
              <h3 className="font-semibold">Real-time Heart Rate Trend (BPM)</h3>
            </div>
            <span className="text-xs text-slate-400">Updated every 3 seconds</span>
          </div>

          <div className="h-44 flex items-end gap-2 pt-6 px-2 border-b border-slate-800">
            {historyHR.map((val, idx) => {
              const heightPct = Math.min(100, Math.max(20, ((val - 45) / 55) * 100));
              return (
                <div key={idx} className="flex-1 flex flex-col items-center gap-2">
                  <span className="text-[10px] text-slate-400">{val}</span>
                  <div
                    style={{ height: `${heightPct}%` }}
                    className={`w-full max-w-[36px] rounded-t-md transition-all duration-300 ${
                      val < 65 ? "bg-indigo-500" : "bg-rose-500"
                    }`}
                  />
                </div>
              );
            })}
          </div>
        </div>

      </div>
    </div>
  );
}