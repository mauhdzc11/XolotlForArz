import 'dotenv/config';
import express from 'express';
import http from 'http';
import cors from 'cors';
import mqtt from 'mqtt';
import { Server as SocketIOServer } from 'socket.io';

const {
  PORT = 3001,
  MQTT_HOST = '192.168.1.60',
  MQTT_PORT = 1883,
  MQTT_USER = '',
  MQTT_PASS = '',
  MQTT_BASE = 'axolotl/tank2'
} = process.env;

const app = express();
app.use(cors());
app.use(express.json());

const server = http.createServer(app);
const io = new SocketIOServer(server, {
  cors: { origin: '*' }
});

// ---- MQTT ----
const mqttUrl = `mqtt://${MQTT_HOST}:${MQTT_PORT}`;
const mqttOptions = {
  username: MQTT_USER || undefined,
  password: MQTT_PASS || undefined,
  keepalive: 30,
  reconnectPeriod: 1500
};

const client = mqtt.connect(mqttUrl, mqttOptions);

const TOPIC_TELE = `${MQTT_BASE}/telemetry`;
const TOPIC_STATE = `${MQTT_BASE}/state`;
const TOPIC_CMD_FAN = `${MQTT_BASE}/cmd/fan`;
const TOPIC_CMD_SETPOINTS = `${MQTT_BASE}/cmd/setpoints`;

let latest = {
  telemetry: null,
  state: null,
  lastSeen: null
};

client.on('connect', () => {
  console.log('[MQTT] connected:', mqttUrl);
  client.subscribe([TOPIC_TELE, TOPIC_STATE], { qos: 0 });
});

client.on('reconnect', () => console.log('[MQTT] reconnecting...'));
client.on('error', (e) => console.log('[MQTT] error:', e.message));

client.on('message', (topic, payload) => {
  const text = payload.toString();
  let json = null;

  try { json = JSON.parse(text); } catch { /* ignore */ }

  if (topic === TOPIC_TELE) {
    latest.telemetry = json ?? { raw: text };
    latest.lastSeen = Date.now();
    io.emit('telemetry', latest.telemetry);
  } else if (topic === TOPIC_STATE) {
    latest.state = json ?? { raw: text };
    latest.lastSeen = Date.now();
    io.emit('state', latest.state);
  }
});

// ---- API opcional ----
app.get('/api/health', (_, res) => res.json({ ok: true }));
app.get('/api/latest', (_, res) => res.json(latest));

app.post('/api/fan', (req, res) => {
  const v = req.body?.value;
  if (v !== 0 && v !== 1) return res.status(400).json({ error: 'value must be 0 or 1' });
  client.publish(TOPIC_CMD_FAN, String(v));
  res.json({ ok: true });
});

app.post('/api/setpoints', (req, res) => {
  const { warn, high, emergency } = req.body || {};
  const msg = JSON.stringify({ warn, high, emergency });
  client.publish(TOPIC_CMD_SETPOINTS, msg);
  res.json({ ok: true });
});

// ---- Socket.IO ----
io.on('connection', (socket) => {
  socket.emit('hello', { ok: true });
  if (latest.telemetry) socket.emit('telemetry', latest.telemetry);
  if (latest.state) socket.emit('state', latest.state);

  socket.on('cmd:fAN', () => {}); // (placeholder por si te equivocas de evento)

  socket.on('cmd:fan', (value) => {
    if (value === 0 || value === 1) client.publish(TOPIC_CMD_FAN, String(value));
  });

  socket.on('cmd:setpoints', (sp) => {
    if (!sp) return;
    client.publish(TOPIC_CMD_SETPOINTS, JSON.stringify(sp));
  });
});

server.listen(PORT, () => {
  console.log(`[HTTP] listening on http://localhost:${PORT}`);
});