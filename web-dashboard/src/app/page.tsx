"use client";

import React, { useState, useEffect } from "react";
import mqtt from "mqtt";
import { BellOff, Fan } from "lucide-react";

const MQTT_BROKER_URL = "wss://broker.emqx.io:8084/mqtt";
const TOPIC_TELEMETRY = "smartsleep/wachiraw1tch/telemetry";
const TOPIC_COMMAND = "smartsleep/wachiraw1tch/command";

// If no telemetry arrives within this window, the device is treated as offline.
const STALE_AFTER_MS = 20_000;
const MAX_HISTORY = 30;

type SleepStage = "DEEP_SLEEP" | "LIGHT_SLEEP" | "AWAKE";

// Every field is null until the first real telemetry message arrives.
interface SleepTelemetry {
  hr: number | null;
  spo2: number | null;
  accel: number | null;
  on_bed: boolean | null;
  temp: number | null;
  hum: number | null;
  light: number | null;
  noise: number | null;
  sleep_stage: SleepStage | null;
  alarm_active: boolean | null;
  fan_relay: boolean | null;
}

const EMPTY_DATA: SleepTelemetry = {
  hr: null,
  spo2: null,
  accel: null,
  on_bed: null,
  temp: null,
  hum: null,
  light: null,
  noise: null,
  sleep_stage: null,
  alarm_active: null,
  fan_relay: null,
};

const STAGE_META: Record<SleepStage, { label: string; note: string; color: string }> = {
  DEEP_SLEEP: {
    label: "Deep sleep",
    note: "Too early to wake. The system waits for light sleep before starting the alarm.",
    color: "#8fb0e8",
  },
  LIGHT_SLEEP: {
    label: "Light sleep",
    note: "Good window to wake. The sunrise light ramps up gradually.",
    color: "#f0b35a",
  },
  AWAKE: {
    label: "Awake",
    note: "Sustained movement detected.",
    color: "#ef8a7b",
  },
};

const fmt = (v: number | null, digits = 0) =>
  v === null || Number.isNaN(v) ? "--" : digits > 0 ? v.toFixed(digits) : String(Math.round(v));

function HeartRateChart({ values }: { values: number[] }) {
  const W = 600;
  const H = 180;
  const padY = 14;
  const lo = 40;
  const hi = 120;
  const gridValues = [60, 80, 100];

  const yFor = (v: number) => {
    const clamped = Math.min(hi, Math.max(lo, v));
    return H - padY - ((clamped - lo) / (hi - lo)) * (H - padY * 2);
  };

  if (values.length < 2) {
    return (
      <div className="flex h-44 items-center justify-center text-sm text-[#9a9388]">
        {values.length === 0
          ? "No heart rate data received yet."
          : "Waiting for more readings to draw the trend…"}
      </div>
    );
  }

  const pts = values.map((v, i) => ({
    x: (i / (values.length - 1)) * W,
    y: yFor(v),
  }));
  const path = pts.map((p, i) => `${i === 0 ? "M" : "L"}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" ");
  const last = pts[pts.length - 1];

  return (
    <div className="relative pr-8">
      <div className="relative">
        <svg viewBox={`0 0 ${W} ${H}`} className="h-44 w-full overflow-visible" preserveAspectRatio="none">
          {gridValues.map((g) => (
            <line
              key={g}
              x1={0}
              x2={W}
              y1={yFor(g)}
              y2={yFor(g)}
              stroke="#34312b"
              strokeWidth={1}
              strokeDasharray="3 5"
              vectorEffect="non-scaling-stroke"
            />
          ))}
          <path
            d={path}
            fill="none"
            stroke="#f1ebdf"
            strokeWidth={2}
            strokeLinejoin="round"
            strokeLinecap="round"
            vectorEffect="non-scaling-stroke"
          />
        </svg>
        <span
          className="absolute h-2.5 w-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-[#f0b35a]"
          style={{ left: `${(last.x / W) * 100}%`, top: `${(last.y / H) * 100}%` }}
        />
      </div>
      {gridValues.map((g) => (
        <span
          key={g}
          className="absolute right-0 -translate-y-1/2 text-xs tabular-nums text-[#9a9388]"
          style={{ top: `${(yFor(g) / H) * 100}%` }}
        >
          {g}
        </span>
      ))}
    </div>
  );
}

function Metric({
  label,
  sensor,
  value,
  unit,
  sub,
}: {
  label: string;
  sensor: string;
  value: string;
  unit: string;
  sub: string;
}) {
  return (
    <div className="py-6 md:px-6 md:first:pl-0 md:last:pr-0">
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-sm font-medium text-[#f1ebdf]">{label}</span>
        <span className="text-xs text-[#8a8478]">{sensor}</span>
      </div>
      <div className="mt-3 flex items-baseline gap-1.5">
        <span className="text-5xl font-semibold tabular-nums tracking-tight">{value}</span>
        <span className="text-base text-[#b3ab9c]">{unit}</span>
      </div>
      <p className="mt-2 text-sm text-[#b3ab9c]">{sub}</p>
    </div>
  );
}

export default function SmartSleepDashboard() {
  const [mqttClient, setMqttClient] = useState<mqtt.MqttClient | null>(null);
  const [isConnected, setIsConnected] = useState(false);
  const [data, setData] = useState<SleepTelemetry>(EMPTY_DATA);
  const [historyHR, setHistoryHR] = useState<number[]>([]);
  const [lastUpdate, setLastUpdate] = useState<number | null>(null);
  // Set only on the client (effect/event handlers) so nothing time-based runs during prerender
  const [now, setNow] = useState<number | null>(null);

  // 1. Connect to the HiveMQ broker (same topics as the ESP32-S3 on Wokwi / hardware)
  useEffect(() => {
    let active = true;
    console.log("[MQTT] Connecting to:", MQTT_BROKER_URL);

    const client = mqtt.connect(MQTT_BROKER_URL, {
      clientId: `web_${Math.random().toString(16).slice(2, 10)}`,
      clean: true,
      connectTimeout: 10000,
      reconnectPeriod: 2000,
    });

    client.on("connect", () => {
      if (!active) return;
      console.log("[MQTT] Connected!");
      setIsConnected(true);
      client.subscribe(TOPIC_TELEMETRY, (err) => {
        if (err) console.error("[MQTT] Subscribe error:", err);
        else console.log("[MQTT] Subscribed:", TOPIC_TELEMETRY);
      });
    });

    client.on("error", (err) => {
      console.warn("[MQTT] Error:", err.message || err);
      if (active) setIsConnected(false);
    });

    client.on("close", () => {
      console.warn("[MQTT] Connection closed");
      if (active) setIsConnected(false);
    });

    client.on("message", (topic, message) => {
      if (!active || topic !== TOPIC_TELEMETRY) return;
      try {
        const parsed = JSON.parse(message.toString());
        const t = Date.now();
        setLastUpdate(t);
        setNow(t);

        setData((prev) => ({
          hr: parsed.hr ?? prev.hr,
          spo2: parsed.spo2 ?? prev.spo2,
          accel: parsed.movement ?? parsed.accel ?? prev.accel,
          on_bed: parsed.onBed ?? parsed.on_bed ?? prev.on_bed,
          temp: parsed.temp ?? prev.temp,
          hum: parsed.humidity ?? parsed.hum ?? prev.hum,
          light: parsed.light ?? prev.light,
          noise: parsed.noise ?? prev.noise,
          sleep_stage: parsed.sleepStage ?? parsed.sleep_stage ?? prev.sleep_stage,
          alarm_active: parsed.pwmOn ?? parsed.alarm_active ?? prev.alarm_active,
          fan_relay: parsed.fanOn ?? parsed.fan_relay ?? prev.fan_relay,
        }));

        if (typeof parsed.hr === "number" && parsed.hr > 0) {
          setHistoryHR((prev) => [...prev.slice(-(MAX_HISTORY - 1)), parsed.hr]);
        }
      } catch (e) {
        console.error("Invalid JSON from MQTT:", e);
      }
    });

    setMqttClient(client);
    return () => {
      active = false;
      client.end(true);
    };
  }, []);

  // Clock tick so "last update" and the stale check stay current
  useEffect(() => {
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  // 2. Send control commands back to the ESP32-S3 gateway.
  //    The UI only changes when the board reports the new state in telemetry.
  const sendCommand = (cmd: "STOP_ALARM" | "TOGGLE_FAN") => {
    if (!mqttClient || !isConnected) return;
    if (cmd === "STOP_ALARM") {
      mqttClient.publish(TOPIC_COMMAND, JSON.stringify({ action: "STOP_ALARM" }));
    } else {
      mqttClient.publish(
        TOPIC_COMMAND,
        JSON.stringify({ action: "TOGGLE_FAN", value: !data.fan_relay })
      );
    }
  };

  const ageMs = lastUpdate === null || now === null ? null : Math.max(0, now - lastUpdate);
  const deviceLive = ageMs !== null && ageMs < STALE_AFTER_MS;
  const stage = data.sleep_stage ? STAGE_META[data.sleep_stage] : null;

  let deviceStatus = "Waiting for device data";
  if (lastUpdate !== null) {
    const secs = Math.floor((ageMs ?? 0) / 1000);
    deviceStatus = deviceLive ? `Live · updated ${secs}s ago` : `No data for ${secs}s`;
  }

  const lightNote =
    data.light === null ? "No reading" : data.light < 150 ? "Dark enough for sleep" : "A bit bright";
  const noiseNote =
    data.noise === null ? "No reading" : data.noise < 45 ? "Quiet" : data.noise < 60 ? "Some noise" : "Loud";

  return (
    <div className="min-h-screen bg-[#14130f] text-[#f1ebdf] antialiased selection:bg-[#f0b35a]/30">
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&display=swap');
        .page-font { font-family: 'Inter', system-ui, -apple-system, 'Segoe UI', sans-serif; font-feature-settings: 'tnum'; }
      `}</style>

      <div className="page-font mx-auto max-w-5xl px-6 py-10 md:py-14">
        {/* Header */}
        <header className="flex flex-col gap-5 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <p className="text-sm font-medium text-[#f0b35a]">Smart Sleep Cycle &amp; Wake-up Assistant</p>
            <h1 className="mt-1 text-3xl font-semibold tracking-tight md:text-4xl">Sleep monitor</h1>
          </div>

          <div className="flex flex-col gap-1.5 text-sm text-[#b3ab9c] sm:items-end">
            <span className="flex items-center gap-2">
              <span className={`h-2 w-2 rounded-full ${isConnected ? "bg-[#9bd1a0]" : "bg-[#ef8a7b]"}`} />
              {isConnected ? "Broker connected" : "Broker offline"}
            </span>
            <span className="flex items-center gap-2">
              <span className={`h-2 w-2 rounded-full ${deviceLive ? "bg-[#9bd1a0]" : "bg-[#6d675c]"}`} />
              {deviceStatus}
            </span>
          </div>
        </header>

        {/* Stage + controls */}
        <section className="mt-10 grid gap-12 border-t border-[#34312b] pt-10 md:grid-cols-[1.6fr_1fr] md:gap-16">
          <div>
            <p className="text-sm font-medium text-[#b3ab9c]">Current sleep stage</p>
            <h2
              className="mt-3 text-5xl font-semibold leading-tight tracking-tight transition-colors duration-700 md:text-6xl"
              style={{ color: stage ? stage.color : "#6d675c" }}
            >
              {stage ? stage.label : "No data"}
            </h2>
            <p className="mt-4 max-w-md text-base leading-relaxed text-[#cfc7b8]">
              {stage ? stage.note : "Waiting for the first telemetry message from the ESP32 gateway."}
            </p>

            <dl className="mt-8 flex gap-12">
              <div>
                <dt className="text-sm text-[#b3ab9c]">Movement</dt>
                <dd className="mt-1 text-lg font-medium tabular-nums">
                  {fmt(data.accel, 2)} <span className="text-sm font-normal text-[#b3ab9c]">m/s²</span>
                </dd>
              </div>
              <div>
                <dt className="text-sm text-[#b3ab9c]">Bed occupancy</dt>
                <dd className="mt-1 text-lg font-medium">
                  {data.on_bed === null ? "--" : data.on_bed ? "On bed" : "Empty"}
                </dd>
              </div>
            </dl>
          </div>

          <div>
            <p className="text-sm font-medium text-[#b3ab9c]">Actuators</p>

            <ul className="mt-3 divide-y divide-[#34312b] border-y border-[#34312b]">
              <li className="flex items-center justify-between py-4">
                <span className="text-base">Sunrise wake-up light</span>
                <span
                  className={`text-sm font-medium ${
                    data.alarm_active ? "text-[#f0b35a]" : "text-[#9a9388]"
                  }`}
                >
                  {data.alarm_active === null ? "--" : data.alarm_active ? "Dimming up" : "Standby"}
                </span>
              </li>
              <li className="flex items-center justify-between py-4">
                <span className="text-base">Fan</span>
                <span
                  className={`text-sm font-medium ${data.fan_relay ? "text-[#9bd1a0]" : "text-[#9a9388]"}`}
                >
                  {data.fan_relay === null ? "--" : data.fan_relay ? "On" : "Off"}
                </span>
              </li>
            </ul>

            <div className="mt-5 flex gap-3">
              <button
                onClick={() => sendCommand("STOP_ALARM")}
                disabled={!isConnected || !data.alarm_active}
                className="flex flex-1 items-center justify-center gap-2 rounded-md bg-[#f1ebdf] px-4 py-3 text-sm font-semibold text-[#14130f] transition hover:bg-white disabled:cursor-not-allowed disabled:bg-[#2a2823] disabled:text-[#8a8478]"
              >
                <BellOff className="h-4 w-4" />
                Stop alarm
              </button>
              <button
                onClick={() => sendCommand("TOGGLE_FAN")}
                disabled={!isConnected || data.fan_relay === null}
                className="flex flex-1 items-center justify-center gap-2 rounded-md border border-[#4a463d] px-4 py-3 text-sm font-semibold transition hover:border-[#9a9388] disabled:cursor-not-allowed disabled:border-[#2a2823] disabled:text-[#8a8478]"
              >
                <Fan className="h-4 w-4" />
                {data.fan_relay ? "Turn fan off" : "Turn fan on"}
              </button>
            </div>
          </div>
        </section>

        {/* Metrics */}
        <section className="mt-12 grid grid-cols-1 divide-y divide-[#34312b] border-y border-[#34312b] sm:grid-cols-2 md:grid-cols-4 md:divide-x md:divide-y-0">
          <Metric
            label="Heart rate"
            sensor="KY-039"
            value={fmt(data.hr)}
            unit="BPM"
            sub={`SpO₂ ${data.spo2 === null ? "--" : `${fmt(data.spo2)}%`}`}
          />
          <Metric
            label="Room temperature"
            sensor="KY-015"
            value={fmt(data.temp, 1)}
            unit="°C"
            sub={`Humidity ${data.hum === null ? "--" : `${fmt(data.hum)}%`}`}
          />
          <Metric label="Ambient light" sensor="LDR" value={fmt(data.light)} unit="lux" sub={lightNote} />
          <Metric label="Noise level" sensor="KY-037" value={fmt(data.noise)} unit="dB" sub={noiseNote} />
        </section>

        {/* Heart rate trend */}
        <section className="mt-12">
          <div className="flex items-baseline justify-between">
            <h3 className="text-xl font-semibold">Heart rate trend</h3>
            <span className="text-sm text-[#9a9388]">Last {MAX_HISTORY} readings · BPM</span>
          </div>
          <div className="mt-5 border-b border-[#34312b] pb-2">
            <HeartRateChart values={historyHR} />
          </div>
        </section>

        <footer className="mt-12 text-sm text-[#8a8478]">
          ESP32-S3 gateway · ESP-NOW sensor network · {MQTT_BROKER_URL.replace("wss://", "")} ·{" "}
          {TOPIC_TELEMETRY}
        </footer>
      </div>
    </div>
  );
}