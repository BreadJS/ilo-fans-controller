const express = require('express');
const path = require('path');
const fs = require('fs').promises;
const fetch = require('node-fetch');
const https = require('https');
const { Client } = require('ssh2');
const bodyParser = require('body-parser');
const mqtt = require('mqtt');

const config = require('./config.js');

const app = express();
app.use(express.static(path.join(__dirname, 'public')));
app.use(bodyParser.json());

const httpsAgent = new https.Agent({
  rejectUnauthorized: false,
});

let fanData = {};
const sshConfig = {
  host: config.SSH_HOSTNAME,
  port: 22,
  username: config.SSH_USERNAME,
  password: config.SSH_PASSWORD,
  algorithms: {
    kex: ['diffie-hellman-group14-sha1'],
    hostKey: ['ssh-dss', 'ssh-rsa'],  // This specifies the allowed host key algorithms
    pubKey: ['ssh-rsa']  // This specifies the allowed public key algorithms
  },
};

const defaultPresetsData = {
  action: "presets",
  presets: [
    { name: "Silent Mode", speeds: [15] },
    { name: "Normal Mode", speeds: [50] },
    { name: "Turbo Mode", speeds: [100] }
  ]
};

let mqttClient;
if(config.MQTT) {
  mqttClient = mqtt.connect(`mqtt://${config.MQTT_HOSTNAME}`,
    {
      username: config.MQTT_USERNAME,
      password: config.MQTT_PASSWORD
    }
  );
}

console.clear();


(async() => {
  async function getFanSpeeds(mqttPush = false) {
    try {
      const basicAuth = Buffer.from(`${config.SSH_USERNAME}:${config.SSH_PASSWORD}`).toString('base64');
      const response = await fetch(`https://${config.SSH_HOSTNAME}/redfish/v1/chassis/1/Thermal`, {
        headers: {
          'Authorization': `Basic ${basicAuth}`,
          'Content-Type': 'application/json',
        },
        agent: httpsAgent
      });
  
      if (!response.ok) {
        throw new Error(`HTTP error! Status: ${response.status}`);
      }
  
      const data = await response.json();
      for(let i = 0; i < data['Fans'].length; i++) {
        fanData[data['Fans'][i]['FanName']] = data['Fans'][i]['CurrentReading'];
      }

      // Publish Discovery to Home Assistant
      if(config.MQTT) { //config.MQTT
        for(let j = 0; j < data['Temperatures'].length; j++) {
          let tempItem = data['Temperatures'][j];
        
          mqttClient.publish(
            `homeassistant/sensor/${config.MQTT_DEVICE.identifiers[0]}_temp_${tempItem['Number']}/config`,
            JSON.stringify({
              name: tempItem['Name'],
              unique_id: `${config.MQTT_DEVICE.identifiers[0]}_temp_${tempItem['Number']}_temp`,
              state_topic: `homeassistant/sensor/temperature/${config.MQTT_DEVICE.identifiers[0]}_temp_${tempItem['Number']}/state`,
              unit_of_measurement: "°C",
              icon: "mdi:thermometer",
              device_class: null,
              device: config.MQTT_DEVICE
            }),
            { retain: true }
          );

          // Publish Temperature
          publishTemp(tempItem['Number'], tempItem['ReadingCelsius']);
        }
        
        // Logging
        console.log('[MQTT] Updated all temperatures');
      }

      return fanData;
    } catch (error) {
      console.error('Error fetching data:', error);
      return {};
    }
  }

  function connectSSH(config) {
    const conn = new Client();
  
    conn.on('ready', () => {
      console.log('SSH Client :: ready');
    }).on('error', (err) => {
      console.error('Error: ', err);
    }).on('end', () => {
      console.log('SSH Client :: disconnected');
      reconnectSSH(config);  // Reconnect if disconnected
    }).connect(config);
  
    return conn;
  }

  function sendMultipleCommandsSequentially(conn, commands, finalCallback) {
    let index = 0;
    const executeNextCommand = () => {
      if (index < commands.length) {
        executeCommand(conn, commands[index], index + 1, () => {
          index++;
          executeNextCommand(); // Execute the next command after the current one finishes
        });
      } else {
        // Once all commands are finished, call the final callback
        finalCallback();
      }
    };
  
    executeNextCommand(); // Start executing the first command
  }
  
  function executeCommand(conn, command, index, callback) {
    conn.exec(command, (err, stream) => {
      if (err) {
        console.error(`Error executing command ${index}: ${err}`);
        return;
      }
  
      stream.on('close', (code, signal) => {
        if(config.DEBUG) {
          if (code === 0) {
            console.log(`Command ${index} :: closed with code ${code}, signal: ${signal}`);
          } else {
            console.error(`Command ${index} :: closed with non-zero code ${code}, signal: ${signal}`);
          }
        }
        callback();  // Proceed to the next command after current one finishes
      }).on('data', (data) => {
        if(config.DEBUG) {
          console.log(`Command ${index} :: STDOUT: ${data}`);
        }
      }).stderr.on('data', (data) => {
        if(config.DEBUG) {
          console.error(`Command ${index} :: STDERR: ${data}`);
        }
      });
    });
  }

  function reconnectSSH(config) {
    console.log('Attempting to reconnect...');
    setTimeout(() => {
      connectSSH(config);  // Retry connection
    }, 5000);  // Retry after 5 seconds
  }

  // MQTT Set Fan Speed
  function publishFanSpeed(id, speed) {
    // Publish Speed
    mqttClient.publish(
      `homeassistant/sensor/fans/${config.MQTT_DEVICE.identifiers[0]}_fan_${id}/state`,
      `${speed}`,
      { retain: true }
    );
  }
  
  // MQTT Set Temps
  function publishTemp(id, temp) {
    // Publish Temp
    mqttClient.publish(
      `homeassistant/sensor/temperature/${config.MQTT_DEVICE.identifiers[0]}_temp_${id}/state`,
      `${temp}`,
      { retain: true }
    );
  }

  const conn = new Client();

  async function init() {
    conn.on('ready', async () => {
      console.log('[INIT] Starting initialisation...');

      let getFanData = await getFanSpeeds(true);
      
      let fanCommands = [];
      let i = 0;
      for(let fan in getFanData) {
        fanCommands.push(`fan p ${i} min 255`);

        // Publish sensor to Home Assistant
        if(config.MQTT) {
          // Publish discovery
          mqttClient.publish(
            `homeassistant/sensor/${config.MQTT_DEVICE.identifiers[0]}_fan_${i+1}/config`,
            JSON.stringify({
              name: `Fan Block ${i+1} Speed`,
              unique_id: `${config.MQTT_DEVICE.identifiers[0]}_fan_${i+1}_speed`,
              state_topic: `homeassistant/sensor/fans/${config.MQTT_DEVICE.identifiers[0]}_fan_${i+1}/state`,
              unit_of_measurement: "%",
              icon: "mdi:fan",
              device_class: null,
              device: config.MQTT_DEVICE
            }),
            { retain: true }
          );

          // Publish speed
          publishFanSpeed(i+1, getFanData[fan])
        }

        // Add +1
        i++;
      }

      sendMultipleCommandsSequentially(conn, fanCommands, () => {
        console.log('[INIT] Initialisation done!');
      });
    }).on('error', (err) => {
      console.error('Error: ', err);
    }).on('end', () => {
      if(config.DEBUG) {
        console.log('SSH Client :: disconnected');
      }
    }).connect(sshConfig);
  }

  init();


  // Connect to MQTT
  if(config.MQTT) {
    mqttClient.on('connect', () => {
      console.log('[MQTT] Connected to MQTT broker');

      // MQTT Update Temperatures Timer
      setInterval(() => {
        getFanSpeeds(true);
      }, config.TEMP_UPDATE_INTERVAL * 1000)
    });

    mqttClient.on('error', (err) => {
      console.error('[MQTT] Connection error:', err);
    });
  }


  // Returns the fan data
  app.get('/fanData', async (req, res) => {
    let getFanData = await getFanSpeeds();
    res.json(getFanData);
  });

  // Get presets
  app.get('/getPresets', async (req, res) => {
    const filePath = path.join(__dirname, 'presets.json');

    try {
      const data = await fs.readFile(filePath, 'utf-8');
      const json = JSON.parse(data);
      res.json(json.presets); // ✅ send only the array
    } catch (err) {
      if (err.code === 'ENOENT') {
        // File doesn't exist, create with default data
        await fs.writeFile(filePath, JSON.stringify(defaultPresetsData, null, 2), 'utf-8');
        res.json(defaultPresetsData.presets); // ✅ return only presets
      } else {
        console.error('Error reading presets file:', err);
        res.status(500).json({ error: 'Failed to read presets file' });
      }
    }
  });

  // Set presets
  app.post('/setPresets', async (req, res) => {
    const body = req.body;

    const filePath = path.join(__dirname, 'presets.json');
    await fs.writeFile(filePath, JSON.stringify(body, null, 2), 'utf-8');

    res.json(body.presets);
  });

  // Set new speeds
  app.post('/setFans', async (req, res) => {
    let { fans } = req.body;

    console.log('[FAN] Setting fan speeds...');
    
    let fanCommands = [];
    let i = 0;
    for(let fan in fans) {
      fanCommands.push(`fan p ${i} max ${((255 / 100) * fans[fan]).toFixed(0)}`);
      console.log(`[FAN] Fan ${i+1} to ${fans[fan]}%`);
      publishFanSpeed(i+1, fans[fan]);
      i++;
    }
    

    sendMultipleCommandsSequentially(conn, fanCommands, () => {
      res.json(fans);
      console.log('[FAN] Fan speeds have been set!');
    });
  });

  // Start express server
  app.listen(config.SERVICE_PORT, () => {
    console.log(`[API] Server is running on http://localhost:${config.SERVICE_PORT}`);
  });
})();