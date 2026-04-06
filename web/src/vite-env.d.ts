/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_MQTT_URL: string
  readonly VITE_MQTT_USER: string
  readonly VITE_MQTT_PASS: string
  readonly VITE_TOPIC_TELE: string
  readonly VITE_TOPIC_STATUS: string
  readonly VITE_TOPIC_CMD_MODE: string
  readonly VITE_TOPIC_CMD_MANUAL_POWER: string
  readonly VITE_TOPIC_CMD_MANUAL_PWM: string
  readonly VITE_TOPIC_CMD_CONFIG: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
