import { useEffect, useMemo, useRef, useState } from "react";
import mqtt from "mqtt";
import type { MqttClient } from "mqtt";

type Mode = "manual" | "auto";
type ConnState = "connecting" | "connected" | "disconnected";

type Telemetry = {
  tWater?: number;
  unit?: string;
  mode?: Mode;
  fanOn?: boolean;
  fanPercent?: number;
  tempStatus?: string;
  idealMin?: number;
  idealMax?: number;
  warn?: number;
  high?: number;
  emergency?: number;
};

const MQTT_URL = import.meta.env.VITE_MQTT_URL as string;
const MQTT_USER = import.meta.env.VITE_MQTT_USER as string;
const MQTT_PASS = import.meta.env.VITE_MQTT_PASS as string;

const TOPIC_TELE =
  (import.meta.env.VITE_TOPIC_TELE as string) || "axolotl/tank2/telemetry";
const TOPIC_STATUS =
  (import.meta.env.VITE_TOPIC_STATUS as string) || "axolotl/tank2/status";

const TOPIC_CMD_MODE =
  (import.meta.env.VITE_TOPIC_CMD_MODE as string) || "axolotl/tank2/cmd/mode";
const TOPIC_CMD_MANUAL_POWER =
  (import.meta.env.VITE_TOPIC_CMD_MANUAL_POWER as string) ||
  "axolotl/tank2/cmd/manual/power";
const TOPIC_CMD_MANUAL_PWM =
  (import.meta.env.VITE_TOPIC_CMD_MANUAL_PWM as string) ||
  "axolotl/tank2/cmd/manual/pwm";
const TOPIC_CMD_CONFIG =
  (import.meta.env.VITE_TOPIC_CMD_CONFIG as string) || "axolotl/tank2/cmd/config";

const DEFAULT_IDEAL_MIN = 15;
const DEFAULT_IDEAL_MAX = 17;
const DEFAULT_WARN = 20;
const DEFAULT_HIGH = 21;
const DEFAULT_EMERGENCY = 23;
const DEFAULT_MANUAL_PWM = 40;
const MIN_PWM = 10;
const MAX_PWM = 100;

function fmt(n: unknown, d = 2) {
  const num = Number(n);
  if (!Number.isFinite(num)) return "--";
  return num.toFixed(d);
}

function clamp(n: number, min: number, max: number) {
  return Math.min(max, Math.max(min, n));
}

function parseTelemetry(raw: string): Telemetry | null {
  try {
    if (!raw.includes("{")) {
      const tWater = Number(raw);
      if (Number.isFinite(tWater)) {
        return { tWater, unit: "C" };
      }
      return null;
    }

    const msg = JSON.parse(raw) as Record<string, unknown>;

    const toNum = (v: unknown) => {
      const n = Number(v);
      return Number.isFinite(n) ? n : undefined;
    };

    const out: Telemetry = {
      tWater: toNum(msg.tWater),
      unit: typeof msg.unit === "string" ? msg.unit : "C",
      mode: msg.mode === "manual" ? "manual" : msg.mode === "auto" ? "auto" : undefined,
      fanOn:
        typeof msg.fanOn === "boolean"
          ? msg.fanOn
          : msg.fanOn === "true" || msg.fanOn === "1" || msg.fanOn === 1,
      fanPercent: toNum(msg.fanPercent),
      tempStatus: typeof msg.tempStatus === "string" ? msg.tempStatus : undefined,
      idealMin: toNum(msg.idealMin),
      idealMax: toNum(msg.idealMax),
      warn: toNum(msg.warn),
      high: toNum(msg.high),
      emergency: toNum(msg.emergency),
    };

    return out;
  } catch (e) {
    console.log("Error parseando telemetría:", e, raw);
    return null;
  }
}

function tempBadgeFromTelemetry(
  tempStatus: string | undefined,
  tWater: unknown,
  idealMin: number,
  idealMax: number,
  emergency: number
): { cls: "ok" | "warn" | "bad"; text: string } {
  const t = Number(tWater);

  if (!Number.isFinite(t) || t === -127) return { cls: "bad" as const, text: "sensor" };

  if (tempStatus === "ok") return { cls: "ok" as const, text: "ideal" };
  if (tempStatus === "cool") return { cls: "warn" as const, text: "fría" };
  if (tempStatus === "warm") return { cls: "warn" as const, text: "templada" };
  if (tempStatus === "warning") return { cls: "warn" as const, text: "advertencia" };
  if (tempStatus === "high") return { cls: "bad" as const, text: "alta" };
  if (tempStatus === "emergency") return { cls: "bad" as const, text: "emergencia" };

  if (t >= emergency) return { cls: "bad" as const, text: "emergencia" };
  if (t > idealMax) return { cls: "warn" as const, text: "templada" };
  if (t < idealMin) return { cls: "warn" as const, text: "fría" };
  return { cls: "ok" as const, text: "ideal" };
}

export default function App() {
  const [conn, setConn] = useState<ConnState>("connecting");
  const [tele, setTele] = useState<Telemetry | null>(null);
  const [lastSeen, setLastSeen] = useState<number | null>(null);
  const [lastErr, setLastErr] = useState("");
  const [statusTextDevice, setStatusTextDevice] = useState<string>("sin estado");

  const [mode, setMode] = useState<Mode>("auto");
  const [manualFanOn, setManualFanOn] = useState(false);
  const [manualPwm, setManualPwm] = useState(DEFAULT_MANUAL_PWM);

  const [idealMin, setIdealMin] = useState(DEFAULT_IDEAL_MIN);
  const [idealMax, setIdealMax] = useState(DEFAULT_IDEAL_MAX);
  const [warnTemp, setWarnTemp] = useState(DEFAULT_WARN);
  const [highTemp, setHighTemp] = useState(DEFAULT_HIGH);
  const [emergencyTemp, setEmergencyTemp] = useState(DEFAULT_EMERGENCY);

  const [logoOk, setLogoOk] = useState(false);
  const [axoOk, setAxoOk] = useState(false);
  const [nowTick, setNowTick] = useState(Date.now());

  const clientRef = useRef<MqttClient | null>(null);
  const clientId = useMemo(
    () => `xolotl-web-tank2-${Math.random().toString(16).slice(2)}`,
    []
  );

  useEffect(() => {
    const timer = window.setInterval(() => setNowTick(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    if (!MQTT_URL || !MQTT_USER) {
      console.error("Faltan variables VITE_MQTT_URL o VITE_MQTT_USER");
    }

    setConn("connecting");
    setLastErr("");

    const client = mqtt.connect(MQTT_URL, {
      username: MQTT_USER,
      password: MQTT_PASS,
      clientId,
      reconnectPeriod: 5000,
      keepalive: 30,
      clean: true,
      protocolVersion: 4,
    });

    clientRef.current = client;

    client.on("connect", () => {
      setConn("connected");
      setLastErr("");
      client.subscribe(TOPIC_TELE);
      client.subscribe(TOPIC_STATUS);
    });

    client.on("reconnect", () => setConn("connecting"));
    client.on("close", () => setConn("disconnected"));

    client.on("error", (e) => {
      console.error("MQTT error:", e);
      setConn("disconnected");
      setLastErr(String((e as Error)?.message || e));
    });

    client.on("message", (topic, payload) => {
      const raw = payload.toString();

      if (topic === TOPIC_STATUS) {
        setStatusTextDevice(raw || "sin estado");
        return;
      }

      if (topic !== TOPIC_TELE) return;

      const parsed = parseTelemetry(raw);
      if (!parsed) return;

      setTele(parsed);
      setLastSeen(Date.now());

      if (parsed.mode) setMode(parsed.mode);
      if (typeof parsed.fanOn === "boolean") setManualFanOn(parsed.fanOn);
      if (Number.isFinite(parsed.fanPercent)) {
        setManualPwm(clamp(Number(parsed.fanPercent), MIN_PWM, MAX_PWM));
      }

      if (Number.isFinite(parsed.idealMin)) setIdealMin(Number(parsed.idealMin));
      if (Number.isFinite(parsed.idealMax)) setIdealMax(Number(parsed.idealMax));
      if (Number.isFinite(parsed.warn)) setWarnTemp(Number(parsed.warn));
      if (Number.isFinite(parsed.high)) setHighTemp(Number(parsed.high));
      if (Number.isFinite(parsed.emergency)) setEmergencyTemp(Number(parsed.emergency));
    });

    return () => {
      client.end(true);
      clientRef.current = null;
    };
  }, [clientId]);

  const secondsAgo =
    lastSeen === null ? null : Math.max(0, Math.round((nowTick - lastSeen) / 1000));

  const badge = tempBadgeFromTelemetry(
    tele?.tempStatus,
    tele?.tWater,
    idealMin,
    idealMax,
    emergencyTemp
  );

  const statusText =
    conn === "connected"
      ? "Conectado"
      : conn === "connecting"
        ? "Conectando"
        : "Desconectado";

  const publish = (topic: string, value: string) => {
    const client = clientRef.current;
    if (!client || !client.connected) return false;
    client.publish(topic, value, { qos: 0, retain: false });
    return true;
  };

  const sendMode = (nextMode: Mode) => {
    const ok = publish(TOPIC_CMD_MODE, nextMode);
    if (ok) setMode(nextMode);
  };

  const sendManualPower = (fanOn: boolean) => {
    const ok = publish(TOPIC_CMD_MANUAL_POWER, fanOn ? "on" : "off");
    if (ok) setManualFanOn(fanOn);
  };

  const sendManualPwm = (percent: number) => {
    const value = clamp(Math.round(percent), MIN_PWM, MAX_PWM);
    const ok = publish(TOPIC_CMD_MANUAL_PWM, String(value));
    if (ok) setManualPwm(value);
  };

  const sendAutoConfig = () => {
    const payload = JSON.stringify({
      idealMin: Number(idealMin),
      idealMax: Number(idealMax),
      warn: Number(warnTemp),
      high: Number(highTemp),
      emergency: Number(emergencyTemp),
    });

    const ok = publish(TOPIC_CMD_CONFIG, payload);
    if (ok) {
      setTele((prev) => ({
        ...prev,
        idealMin: Number(idealMin),
        idealMax: Number(idealMax),
        warn: Number(warnTemp),
        high: Number(highTemp),
        emergency: Number(emergencyTemp),
      }));
    }
  };

  const shownFanPercent = Number.isFinite(tele?.fanPercent)
    ? Math.round(Number(tele?.fanPercent))
    : manualPwm;

  const shownFanOn =
    typeof tele?.fanOn === "boolean"
      ? tele.fanOn
      : mode === "manual"
        ? manualFanOn
        : false;

  return (
    <div className="pageShell">
      <div className="mobileApp">
        <header className="topbar">
          <div className="brandWrap">
            <div className="brandIcon" title="Pon tu logo en /public/logo.png">
              {!logoOk && <div className="brandFallback">xo</div>}
              <img
                className="brandImg"
                src="/logo.png"
                alt="logo"
                onLoad={() => setLogoOk(true)}
                onError={() => setLogoOk(false)}
              />
            </div>

            <div>
              <div className="eyebrow">Monitoreo del ajolote</div>
              <h1>Control de temperatura</h1>
            </div>
          </div>

          <div className="statusPill">
            <span
              className={`dot ${
                conn === "connected" ? "ok" : conn === "connecting" ? "warn" : "bad"
              }`}
            />
            <span>{statusText}</span>
            <span className="sep">•</span>
            <span>{secondsAgo === null ? "sin datos" : `${secondsAgo}s`}</span>
          </div>
        </header>

        <section className="card heroCard">
          <div className="heroTop">
            <div className="axoBox" title="Pon tu imagen en /public/axolotl.png">
              {!axoOk && (
                <div className="axoFace" aria-hidden="true">
                  <i />
                </div>
              )}
              <img
                className="axoImg"
                src="/axolotl.png"
                alt="axolotl"
                onLoad={() => setAxoOk(true)}
                onError={() => setAxoOk(false)}
              />
            </div>

            <div className="heroText">
              <div className="eyebrow">Temperatura del agua</div>
              <div className="tempBig">
                {fmt(tele?.tWater, 2)} <span>°C</span>
              </div>
              <div className="subline">
                Ideal {fmt(idealMin, 1)}–{fmt(idealMax, 1)} °C
              </div>
            </div>
          </div>

          <div className="chips">
            <span className={`chip ${badge.cls}`}>Estado: {badge.text}</span>
            <span className="chip">
              Modo: {mode === "manual" ? "manual" : "automático"}
            </span>
            <span className="chip">PWM: {shownFanPercent}%</span>
            <span className="chip">
              Ventilador: {shownFanOn ? "encendido" : "apagado"}
            </span>
          </div>
        </section>

        <section className="card">
          <div className="sectionHead">
            <div>
              <div className="eyebrow">Modo de trabajo</div>
              <h2>Control</h2>
            </div>
          </div>

          <div className="segmented">
            <button
              className={`segment ${mode === "manual" ? "active" : ""}`}
              onClick={() => sendMode("manual")}
              disabled={conn !== "connected"}
            >
              Manual
            </button>
            <button
              className={`segment ${mode === "auto" ? "active" : ""}`}
              onClick={() => sendMode("auto")}
              disabled={conn !== "connected"}
            >
              Automático
            </button>
          </div>

          <div className="modeHint">
            {mode === "manual"
              ? "En manual decides si el ventilador está encendido y con qué potencia trabajar."
              : "En automático el micro mantiene 40% dentro del rango, sube al calentarse y se apaga si baja del mínimo ideal."}
          </div>
        </section>

        <section className="card">
          <div className="sectionHead compact">
            <div>
              <div className="eyebrow">Modo manual</div>
              <h2>Ventilador</h2>
            </div>
            <span className={`tinyState ${mode === "manual" ? "ok" : "muted"}`}>
              {mode === "manual" ? "activo" : "bloqueado"}
            </span>
          </div>

          <div className="buttonRow">
            <button
              className={`btn ${shownFanOn && mode === "manual" ? "primary" : "soft"}`}
              onClick={() => sendManualPower(true)}
              disabled={conn !== "connected" || mode !== "manual"}
            >
              Encender
            </button>
            <button
              className={`btn ${!shownFanOn && mode === "manual" ? "dangerSoft" : "soft"}`}
              onClick={() => sendManualPower(false)}
              disabled={conn !== "connected" || mode !== "manual"}
            >
              Apagar
            </button>
          </div>

          <div className="rangeWrap">
            <div className="rangeHeader">
              <span>Intensidad</span>
              <strong>{manualPwm}%</strong>
            </div>
            <input
              className="slider"
              type="range"
              min={MIN_PWM}
              max={MAX_PWM}
              step={1}
              value={manualPwm}
              disabled={conn !== "connected" || mode !== "manual"}
              onChange={(e) => {
                const value = Number(e.currentTarget.value);
                setManualPwm(value);
                sendManualPwm(value);
              }}
            />
            <div className="rangeMarks">
              <span>{MIN_PWM}%</span>
              <span>55%</span>
              <span>100%</span>
            </div>
          </div>
        </section>

        <section className="card">
          <div className="sectionHead compact">
            <div>
              <div className="eyebrow">Modo automático</div>
              <h2>Rango objetivo</h2>
            </div>
            <span className={`tinyState ${mode === "auto" ? "ok" : "muted"}`}>
              {mode === "auto" ? "activo" : "en espera"}
            </span>
          </div>

          <div className="fieldsGrid">
            <label>
              <span>Mínimo ideal</span>
              <input
                type="number"
                step="0.1"
                inputMode="decimal"
                value={idealMin}
                onChange={(e) => setIdealMin(Number(e.currentTarget.value))}
              />
            </label>

            <label>
              <span>Máximo ideal</span>
              <input
                type="number"
                step="0.1"
                inputMode="decimal"
                value={idealMax}
                onChange={(e) => setIdealMax(Number(e.currentTarget.value))}
              />
            </label>

            <label>
              <span>Advertencia</span>
              <input
                type="number"
                step="0.1"
                inputMode="decimal"
                value={warnTemp}
                onChange={(e) => setWarnTemp(Number(e.currentTarget.value))}
              />
            </label>

            <label>
              <span>Alto</span>
              <input
                type="number"
                step="0.1"
                inputMode="decimal"
                value={highTemp}
                onChange={(e) => setHighTemp(Number(e.currentTarget.value))}
              />
            </label>

            <label>
              <span>Emergencia</span>
              <input
                type="number"
                step="0.1"
                inputMode="decimal"
                value={emergencyTemp}
                onChange={(e) => setEmergencyTemp(Number(e.currentTarget.value))}
              />
            </label>
          </div>

          <button
            className="btn primary full"
            onClick={sendAutoConfig}
            disabled={conn !== "connected"}
          >
            Guardar rango automático
          </button>

          <p className="helperText">
            En automático el sistema mantiene 40% dentro del rango, sube gradualmente si pasa del máximo ideal y se apaga si baja del mínimo ideal.
          </p>
        </section>

        <section className="card statusCard">
          <div className="sectionHead compact">
            <div>
              <div className="eyebrow">Diagnóstico</div>
              <h2>Estado del sistema</h2>
            </div>
          </div>

          <div className="statusList">
            <div><b>MQTT web:</b> {statusText}</div>
            <div><b>Micro:</b> {statusTextDevice}</div>
            <div><b>Último dato:</b> {secondsAgo === null ? "--" : `${secondsAgo}s`}</div>
            <div><b>Telemetría:</b> {TOPIC_TELE}</div>
            <div><b>Cmd modo:</b> {TOPIC_CMD_MODE}</div>
            <div><b>Cmd power:</b> {TOPIC_CMD_MANUAL_POWER}</div>
            <div><b>Cmd pwm:</b> {TOPIC_CMD_MANUAL_PWM}</div>
            {lastErr ? <div className="err"><b>Error:</b> {lastErr}</div> : null}
          </div>
        </section>
      </div>
    </div>
  );
}