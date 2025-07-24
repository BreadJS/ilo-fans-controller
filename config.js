module.exports = {
  SSH_HOSTNAME: "192.168.3.1",
  SSH_USERNAME: "USERNAME",
  SSH_PASSWORD: "PASSWORD",
  SERVICE_PORT: 80,
  DEBUG: false,

  MQTT: true,
  MQTT_HOSTNAME: "192.168.1.4",   // Home Assistant MQTT broker endpoint
  MQTT_USERNAME: "mqtt",
  MQTT_PASSWORD: "mqtt",
  MQTT_DEVICE: {
    identifiers: ["proxmoxS1"],   // Your identifier name, you can name this whatever you want
    manufacturer: "HP iLO 4",
    model: "Fan Controller",
    name: "Server Fan Controller",
    sw_version: "1.1.0"
  },
  TEMP_UPDATE_INTERVAL: 30
}