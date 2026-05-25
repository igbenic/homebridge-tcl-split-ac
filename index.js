const axios  = require('axios');
const crypto = require('crypto');
const jwt    = require('jsonwebtoken');
const {
  IoTDataPlaneClient,
  GetThingShadowCommand,
  PublishCommand,
} = require('@aws-sdk/client-iot-data-plane');

// TCL TAC-BR12INV workMode values observed through Device Shadow.
const MODE = {
  AUTO: 0,
  COOL: 1,
  DRY:  2,
  FAN:  3,
  HEAT: 4,
};

// TCL TAC-BR12INV windSpeed values observed through Device Shadow.
const WIND = {
  AUTO:     0,
  SILENT:   2,
  LOW:      2,
  MED_LOW:  3,
  MED:      4,
  MED_HIGH: 5,
  HIGH:     6,
  TURBO:    6,
};

module.exports = (homebridge) => {
  homebridge.registerPlatform('homebridge-tcl-split-ac', 'TclHome', TclHomePlatform);
};

// Homebridge platform.
class TclHomePlatform {
  constructor(log, config, api) {
    this.log = log;
    this.config = config;
    this.api = api;
    this.accessories = [];

    if (!config || !config.username || !config.password) {
      this.log.error('Username and password are required in config');
      return;
    }

    this.tclApi = new TclHomeApi({
      username:    config.username,
      password:    config.password,
      appLoginUrl: config.appLoginUrl || 'https://pa.account.tcl.com/account/login?clientId=54148614',
      cloudUrls:   config.cloudUrls   || 'https://prod-center.aws.tcljd.com/v3/global/cloud_url_get',
      appId:       config.appId       || 'wx6e1af3fa84fbe523',
      debugMode:   config.debugMode   || false,
      log:         this.log,
    });

    this.api.on('didFinishLaunching', () => this.discoverDevices());
  }

  async discoverDevices() {
    try {
      this.log.info('Discovering TCL devices...');
      await this.tclApi.initialize();
      const devices = await this.tclApi.getDevices();
      this.log.info(`Found ${devices.length} device(s)`);
      for (const device of devices) {
        if (device.category === 'AC') this.addAccessory(device);
      }
    } catch (err) {
      this.log.error('discoverDevices:', err.message);
    }
  }

  addAccessory(device) {
    const uuid = this.api.hap.uuid.generate(device.deviceId);
    const existing = this.accessories.find(a => a.UUID === uuid);
    if (existing) {
      new TclAirConditioner(this, existing, device);
    } else {
      const acc = new this.api.platformAccessory(device.deviceName, uuid);
      new TclAirConditioner(this, acc, device);
      this.api.registerPlatformAccessories('homebridge-tcl-split-ac', 'TclHome', [acc]);
      this.accessories.push(acc);
    }
  }

  configureAccessory(acc) {
    this.accessories.push(acc);
  }
}

// TCL API
class TclHomeApi {
  constructor(config) {
    Object.assign(this, config);
    this.authData          = null;
    this.cloudUrlsData     = null;
    this.refreshTokensData = null;
    this.awsCredentials    = null;
    this.iotData           = null;
    this.stateCache        = {};
    this.lastCall          = {};
    this.authRetry         = 0;
    this.maxAuthRetry      = 3;
  }

  dbg(msg, ...a) {
    if (this.debugMode) this.log.info(`[DBG] ${msg}`, ...a);
  }

  async initialize() {
    this.log.info('Authenticating...');
    await this.authenticate();
    await this.fetchCloudUrls();
    await this.refreshTokens();
    await this.fetchAwsCredentials();
    await this.setupIot();
    this.log.info('TCL API ready');
  }

  async authenticate() {
    const passHash = crypto.createHash('md5').update(this.password).digest('hex');
    const resp = await axios.post(this.appLoginUrl, {
      equipment: 2, password: passHash, osType: 1,
      username: this.username, clientVersion: '4.8.1',
      osVersion: '6.0', deviceModel: 'AndroidAndroid SDK built for x86',
      captchaRule: 2, channel: 'app',
    }, {
      headers: {
        'th_platform': 'android', 'th_version': '4.8.1',
        'th_appbulid': '830', 'user-agent': 'Android',
        'content-type': 'application/json; charset=UTF-8',
      },
    });
    if (resp.data.status !== 1) throw new Error('Auth failed: ' + resp.data.msg);
    this.authData  = resp.data;
    this.authRetry = 0;
    this.log.info('Authenticated');
  }

  async fetchCloudUrls() {
    const resp = await axios.post(this.cloudUrls, {
      ssoId:    this.authData.user.username,
      ssoToken: this.authData.token,
    }, {
      headers: {
        'user-agent': 'Android',
        'content-type': 'application/json; charset=UTF-8',
      },
    });
    this.cloudUrlsData = resp.data;
  }

  async refreshTokens() {
    const url  = `${this.cloudUrlsData.data.cloud_url}/v3/auth/refresh_tokens`;
    const resp = await axios.post(url, {
      userId:   this.authData.user.username,
      ssoToken: this.authData.token,
      appId:    this.appId,
    }, {
      headers: {
        'user-agent': 'Android',
        'content-type': 'application/json; charset=UTF-8',
        'accept-encoding': 'gzip, deflate, br',
      },
    });
    this.refreshTokensData = resp.data;
  }

  async fetchAwsCredentials() {
    const region  = this.getAwsRegion();
    const decoded = jwt.decode(this.refreshTokensData.data.cognitoToken);
    const resp    = await axios.post(
      `https://cognito-identity.${region}.amazonaws.com/`,
      {
        IdentityId: decoded.sub,
        Logins: {
          'cognito-identity.amazonaws.com': this.refreshTokensData.data.cognitoToken,
        },
      },
      {
        headers: {
          'User-agent':    'aws-sdk-android/2.22.6 Linux/6.1.23 Dalvik/2.1.0/0 en_US',
          'X-Amz-Target':  'AWSCognitoIdentityService.GetCredentialsForIdentity',
          'content-type':  'application/x-amz-json-1.1',
        },
      },
    );
    this.awsCredentials = resp.data;
    this.log.info('AWS credentials OK');
  }

  async setupIot() {
    const region = this.getAwsRegion();
    const creds  = this.awsCredentials.Credentials;
    this.iotData = new IoTDataPlaneClient({
      region,
      endpoint: `https://data-ats.iot.${region}.amazonaws.com`,
      credentials: {
        accessKeyId:     creds.AccessKeyId,
        secretAccessKey: creds.SecretKey,
        sessionToken:    creds.SessionToken,
      },
    });
    this.log.info('AWS IoT ready');
  }

  async getDevices() {
    const url       = `${this.cloudUrlsData.data.device_url}/v3/user/get_things`;
    const timestamp = Date.now().toString();
    const nonce     = Math.random().toString(36).substr(2, 16);
    const sign      = this.md5(timestamp + nonce + this.refreshTokensData.data.saasToken);
    const resp      = await axios.post(url, {}, {
      headers: {
        platform:          'android',
        appversion:        '5.4.1',
        thomeversion:      '4.8.1',
        accesstoken:       this.refreshTokensData.data.saasToken,
        countrycode:       this.authData.user.countryAbbr,
        'accept-language': 'en',
        timestamp,
        nonce,
        sign,
        'user-agent':      'Android',
        'content-type':    'application/json; charset=UTF-8',
        'accept-encoding': 'gzip, deflate, br',
      },
    });
    return resp.data.data || [];
  }

  async getDeviceState(deviceId, force = false) {
    const now = Date.now();
    if (!force && this.lastCall[deviceId] && now - this.lastCall[deviceId] < 200) {
      return this.stateCache[deviceId] || this.defaultState();
    }
    this.lastCall[deviceId] = now;

    if (!this.iotData) return this.stateCache[deviceId] || this.defaultState();

    try {
      const result = await this.iotData.send(new GetThingShadowCommand({ thingName: deviceId }));
      const shadow = JSON.parse(Buffer.from(result.payload).toString('utf8'));
      const rep    = shadow.state?.reported || {};

      // Only trust reported state; desired can contain stale values.
      const state = {
        powerSwitch:        rep.powerSwitch                                    ?? 0,
        workMode:           rep.workMode                                       ?? MODE.COOL,
        windSpeed:          rep.windSpeed                                      ?? WIND.AUTO,
        targetTemperature:  rep.targetCelsiusDegree ?? rep.targetTemperature  ?? 22,
        currentTemperature: rep.currentTemperature                             ?? 22,
        minTemp:            rep.lowerTemperatureLimit                          ?? 16,
        maxTemp:            rep.upperTemperatureLimit                          ?? 31,
        isOnline:           true,
        lastUpdated:        now,
      };

      this.dbg(`${deviceId}: power=${state.powerSwitch} mode=${state.workMode} wind=${state.windSpeed} target=${state.targetTemperature}C room=${state.currentTemperature}C`);
      this.stateCache[deviceId] = state;
      return state;

    } catch (err) {
      this.dbg('Shadow read failed:', err.message);
      const cached = this.stateCache[deviceId];
      if (cached && now - cached.lastUpdated > 30000) {
        delete this.stateCache[deviceId];
        return this.defaultState();
      }
      return cached || this.defaultState();
    }
  }

  defaultState() {
    return {
      powerSwitch: 0, workMode: MODE.COOL, windSpeed: WIND.AUTO,
      targetTemperature: 22, currentTemperature: 22,
      minTemp: 16, maxTemp: 31, isOnline: false, lastUpdated: Date.now(),
    };
  }

  async sendCommand(deviceId, props) {
    if (!this.iotData) {
      this.log.error('IoT not initialized');
      return false;
    }
    const topic   = `$aws/things/${deviceId}/shadow/update`;
    const payload = JSON.stringify({
      state: { desired: props },
      clientToken: `hb_${Date.now()}`,
    });
    this.log.info(`Command -> ${deviceId}:`, JSON.stringify(props));
    try {
      await this.iotData.send(new PublishCommand({
        topic,
        payload: Buffer.from(payload),
        qos: 1,
      }));
      // Update the cache optimistically.
      if (this.stateCache[deviceId]) {
        Object.assign(this.stateCache[deviceId], props);
        if (props.targetCelsiusDegree !== undefined) {
          this.stateCache[deviceId].targetTemperature = props.targetCelsiusDegree;
        }
      }
      this.log.info('Command sent');
      return true;
    } catch (err) {
      if (err.message.includes('Forbidden') || err.message.includes('expired')) {
        this.log.warn('Credentials expired, re-authenticating...');
        await this.reAuth();
        return false;
      }
      this.log.error('Publish failed:', err.message);
      return false;
    }
  }

  async reAuth() {
    if (this.authRetry >= this.maxAuthRetry) {
      this.log.error('Max re-auth attempts. Restart Homebridge.');
      return;
    }
    this.authRetry++;
    this.log.info(`Re-auth attempt ${this.authRetry}/${this.maxAuthRetry}`);
    try {
      await this.initialize();
    } catch (err) {
      this.log.error('Re-auth failed:', err.message);
    }
  }

  md5(input) {
    const hash = crypto.createHash('md5').update(input, 'utf8').digest();
    return Array.from(hash)
      .map(b => ((b & 0xFF) < 16 ? '0' : '') + (b & 0xFF).toString(16))
      .join('');
  }

  getAwsRegion() {
    const region = this.cloudUrlsData?.data?.cloud_region;
    if (typeof region !== 'string' || !/^[a-z]{2}(?:-[a-z0-9]+)+-\d+$/.test(region)) {
      throw new Error(`Unexpected AWS region from TCL cloud: ${String(region)}`);
    }
    return region;
  }
}

// HomeKit accessory.
class TclAirConditioner {
  constructor(platform, accessory, device) {
    this.platform  = platform;
    this.accessory = accessory;
    this.device    = device;
    this.log       = platform.log;
    this.api       = platform.tclApi;
    this.hap       = platform.api.hap;

    this._lastMode      = MODE.COOL;
    this._lastWindSpeed = WIND.AUTO;
    this._minTemp       = 16;
    this._maxTemp       = 31;
    this._errCount      = 0;
    this._lastOkPoll    = Date.now();
    this._lastHkUpdate  = 0;
    this._lastStateKey  = '';

    this.setupAccessoryInfo();
    this.setupThermostat();
    this.removeLegacyServices();
    this.setupFanSpeedControl();
    this.startPolling();

    this.log.info(`${device.deviceName} ready (TAC-BR12INV | Cool/Heat/Auto | 16-31C | 8 fan speeds)`);
  }

  setupAccessoryInfo() {
    this.accessory
      .getService(this.hap.Service.AccessoryInformation)
      .setCharacteristic(this.hap.Characteristic.Manufacturer,     'TCL')
      .setCharacteristic(this.hap.Characteristic.Model,            'TAC-BR12INV')
      .setCharacteristic(this.hap.Characteristic.SerialNumber,     this.device.deviceId)
      .setCharacteristic(this.hap.Characteristic.FirmwareRevision, this.device.firmwareVersion || '1.0.0');
  }

  setupThermostat() {
    const C = this.hap.Characteristic;

    this.thermo = this.accessory.getService(this.hap.Service.Thermostat)
               || this.accessory.addService(this.hap.Service.Thermostat);

    this.thermo.setCharacteristic(C.Name, this.device.deviceName);

    this.thermo.getCharacteristic(C.CurrentHeatingCoolingState)
      .onGet(this.getCurrentMode.bind(this));

    this.thermo.getCharacteristic(C.TargetHeatingCoolingState)
      .setProps({
        validValues: [
          C.TargetHeatingCoolingState.OFF,
          C.TargetHeatingCoolingState.COOL,
          C.TargetHeatingCoolingState.HEAT,
          C.TargetHeatingCoolingState.AUTO,
        ],
      })
      .onGet(this.getTargetMode.bind(this))
      .onSet(this.setTargetMode.bind(this));

    this.thermo.getCharacteristic(C.CurrentTemperature)
      .setProps({ minValue: -50, maxValue: 100, minStep: 0.1 })
      .onGet(this.getCurrentTemp.bind(this));

    this.thermo.getCharacteristic(C.TargetTemperature)
      .setProps({ minValue: 16, maxValue: 31, minStep: 1 })
      .onGet(this.getTargetTemp.bind(this))
      .onSet(this.setTargetTemp.bind(this));

    this.thermo.getCharacteristic(C.TemperatureDisplayUnits)
      .onGet(() => C.TemperatureDisplayUnits.CELSIUS);
  }

  removeLegacyServices() {
    const names = ['Sleep Mode', 'Fan Speed', 'Fan Mode', 'Cool Fan Speed', 'AC Fan', 'Fan Speed Control'];
    for (const name of names) {
      const svc = this.accessory.getService(name);
      if (svc) {
        this.accessory.removeService(svc);
        this.log.info(`Removed legacy service: ${name}`);
      }
    }
  }

  setupFanSpeedControl() {
    const C = this.hap.Characteristic;

    this.fanSvc = this.accessory.getService('Fan Speed Control')
               || this.accessory.addService(this.hap.Service.Fan, 'Fan Speed Control', 'fanSpeedControl');

    // On/Off mirrors the AC power state.
    this.fanSvc.getCharacteristic(C.On)
      .onGet(this.getFanActive.bind(this))
      .onSet(this.setFanActive.bind(this));

    // Fan speed slider.
    // Uses 12.5% steps for eight positions starting at 0% (Auto).
    // 0%        -> Auto        (windSpeed 0)
    // 12.5%     -> Silent      (windSpeed 2)
    // 25%       -> Low         (windSpeed 2)
    // 37.5%     -> Medium-low  (windSpeed 3)
    // 50%       -> Medium      (windSpeed 4)
    // 62.5%     -> Medium-high (windSpeed 5)
    // 75%       -> High        (windSpeed 6)
    // 87.5-100% -> Turbo       (windSpeed 6)
    this.fanSvc.getCharacteristic(C.RotationSpeed)
      .setProps({ minValue: 0, maxValue: 100, minStep: 12.5 })
      .onGet(this.getFanSpeed.bind(this))
      .onSet(this.setFanSpeed.bind(this));
  }

  // HomeKit getters.

  async getCurrentMode() {
    try {
      const s = await this.api.getDeviceState(this.device.deviceId);
      if (!s.powerSwitch) return this.hap.Characteristic.CurrentHeatingCoolingState.OFF;
      if (s.workMode === MODE.HEAT) return this.hap.Characteristic.CurrentHeatingCoolingState.HEAT;
      return this.hap.Characteristic.CurrentHeatingCoolingState.COOL;
    } catch (e) {
      return this.hap.Characteristic.CurrentHeatingCoolingState.OFF;
    }
  }

  async getTargetMode() {
    try {
      const s = await this.api.getDeviceState(this.device.deviceId);
      if (!s.powerSwitch) return this.hap.Characteristic.TargetHeatingCoolingState.OFF;
      return this.workModeToHk(s.workMode);
    } catch (e) {
      return this.hap.Characteristic.TargetHeatingCoolingState.OFF;
    }
  }

  async getCurrentTemp() {
    try {
      const s = await this.api.getDeviceState(this.device.deviceId);
      return s.currentTemperature ?? 22;
    } catch (e) { return 22; }
  }

  async getTargetTemp() {
    try {
      const s = await this.api.getDeviceState(this.device.deviceId);
      return s.targetTemperature ?? 22;
    } catch (e) { return 22; }
  }

  async getFanActive() {
    try {
      const s = await this.api.getDeviceState(this.device.deviceId);
      return s.powerSwitch === 1;
    } catch (e) { return false; }
  }

  async getFanSpeed() {
    try {
      const s = await this.api.getDeviceState(this.device.deviceId);
      if (!s.powerSwitch) return 0;
      return this.windToPercent(s.windSpeed);
    } catch (e) { return 0; }
  }

  // HomeKit setters.

  // The only place where HomeKit mode changes are mapped to workMode.
  async setTargetMode(value) {
    const C = this.hap.Characteristic;
    const modeNames = {
      [C.TargetHeatingCoolingState.OFF]: 'OFF',
      [C.TargetHeatingCoolingState.HEAT]: 'HEAT',
      [C.TargetHeatingCoolingState.COOL]: 'COOL',
      [C.TargetHeatingCoolingState.AUTO]: 'AUTO',
    };
    this.log.info(`setTargetMode -> ${modeNames[value] ?? value}`);

    const cur  = await this.api.getDeviceState(this.device.deviceId, true);
    const temp = cur.targetTemperature ?? 22;
    const wind = cur.windSpeed         ?? this._lastWindSpeed;

    let props;

    switch (value) {
      case C.TargetHeatingCoolingState.OFF:
        props = { powerSwitch: 0 };
        break;

      case C.TargetHeatingCoolingState.COOL:
        this._lastMode = MODE.COOL;
        props = {
          powerSwitch:         1,
          workMode:            MODE.COOL,  // 1
          windSpeed:           wind,
          targetCelsiusDegree: temp,
          targetTemperature:   temp,
          ECO: 0, sleep: 0, turbo: 0, silenceSwitch: 0,
        };
        break;

      case C.TargetHeatingCoolingState.HEAT:
        this._lastMode = MODE.HEAT;
        props = {
          powerSwitch:         1,
          workMode:            MODE.HEAT,  // 4
          windSpeed:           wind,
          targetCelsiusDegree: temp,
          targetTemperature:   temp,
          ECO: 0, sleep: 0, turbo: 0, silenceSwitch: 0,
        };
        break;

      case C.TargetHeatingCoolingState.AUTO:
        this._lastMode = MODE.AUTO;
        props = {
          powerSwitch:         1,
          workMode:            MODE.AUTO,  // 0
          windSpeed:           wind,
          targetCelsiusDegree: temp,
          targetTemperature:   temp,
          ECO: 0, sleep: 0, turbo: 0, silenceSwitch: 0,
        };
        break;

      default:
        this.log.warn(`Unknown HomeKit mode: ${value}`);
        return;
    }

    await this.sendWithRetry(props, 'setTargetMode');
  }

  // Change only temperature; leave the current mode untouched.
  async setTargetTemp(value) {
    try {
      const temp = Math.max(this._minTemp, Math.min(this._maxTemp, Math.round(value)));
      const cur  = await this.api.getDeviceState(this.device.deviceId, true);

      this.log.info(`setTargetTemp -> ${temp}C (power=${cur.powerSwitch}, mode=${cur.workMode})`);

      let props;

      if (!cur.powerSwitch) {
        // Device is off; turn it on using the last known mode.
        props = {
          powerSwitch:         1,
          workMode:            this._lastMode,
          windSpeed:           this._lastWindSpeed,
          targetCelsiusDegree: temp,
          targetTemperature:   temp,
        };
      } else {
        // Only update temperature; do not touch the mode.
        props = {
          targetCelsiusDegree: temp,
          targetTemperature:   temp,
        };
      }

      const ok = await this.sendWithRetry(props, 'setTargetTemp');
      if (ok) {
        this.thermo
          .getCharacteristic(this.hap.Characteristic.TargetTemperature)
          .updateValue(temp);
      }
    } catch (e) {
      this.log.error('setTargetTemp:', e.message);
      throw new this.hap.HapStatusError(this.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    }
  }

  // Power on/off through the Fan service.
  async setFanActive(value) {
    this.log.info(`setFanActive -> ${value ? 'ON' : 'OFF'}`);
    if (!value) {
      await this.sendWithRetry({ powerSwitch: 0 }, 'setFanActive:off');
    } else {
      const cur = await this.api.getDeviceState(this.device.deviceId, true);
      if (!cur.powerSwitch) {
        await this.sendWithRetry({
          powerSwitch: 1,
          workMode:    this._lastMode,
          windSpeed:   this._lastWindSpeed,
        }, 'setFanActive:on');
      }
    }
  }

  // Only change speed; never touch mode from the fan service.
  async setFanSpeed(value) {
    try {
      const wind = this.percentToWind(value);
      this._lastWindSpeed = wind;

      const cur = await this.api.getDeviceState(this.device.deviceId, true);
      const windNames = { 0:'Auto', 2:'Silent/Low', 3:'Medium-low', 4:'Medium', 5:'Medium-high', 6:'High/Turbo' };
      this.log.info(`setFanSpeed -> ${value}% -> windSpeed=${wind} (${windNames[wind]}) | power=${cur.powerSwitch} mode=${cur.workMode}`);

      if (!cur.powerSwitch) {
        // Device is off; remember the speed without powering on.
        this.log.info('Device is off, speed saved for next start');
        return;
      }

      // Send only windSpeed; do not touch the mode.
      await this.sendWithRetry({ windSpeed: wind }, 'setFanSpeed');
    } catch (e) {
      this.log.error('setFanSpeed:', e.message);
      throw new this.hap.HapStatusError(this.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    }
  }

  // Update HomeKit from the device state.
  updateFromState(s) {
    const key = `${s.powerSwitch}-${s.workMode}-${s.windSpeed}-${s.currentTemperature}-${s.targetTemperature}`;
    if (key === this._lastStateKey) return;

    const major = !this._lastStateKey
               || this._lastStateKey.split('-')[0] !== String(s.powerSwitch)
               || this._lastStateKey.split('-')[1] !== String(s.workMode);

    if (!major && Date.now() - this._lastHkUpdate < 500) return;

    this._lastStateKey = key;
    this._lastHkUpdate = Date.now();

    if (major) {
      this.log.info(`power=${s.powerSwitch} mode=${s.workMode} wind=${s.windSpeed} room=${s.currentTemperature}C target=${s.targetTemperature}C`);
    }

    // Update internal state.
    if (s.powerSwitch && s.workMode !== undefined) this._lastMode      = s.workMode;
    if (s.windSpeed   !== undefined)               this._lastWindSpeed = s.windSpeed;
    if (s.minTemp)                                 this._minTemp       = s.minTemp;
    if (s.maxTemp)                                 this._maxTemp       = s.maxTemp;

    const C = this.hap.Characteristic;

    this.thermo.updateCharacteristic(C.CurrentTemperature, s.currentTemperature ?? 22);

    if (s.targetTemperature !== undefined) {
      this.thermo.updateCharacteristic(C.TargetTemperature, s.targetTemperature);
    }

    let curMode, tgtMode;
    if (!s.powerSwitch) {
      curMode = C.CurrentHeatingCoolingState.OFF;
      tgtMode = C.TargetHeatingCoolingState.OFF;
    } else {
      curMode = s.workMode === MODE.HEAT
        ? C.CurrentHeatingCoolingState.HEAT
        : C.CurrentHeatingCoolingState.COOL;
      tgtMode = this.workModeToHk(s.workMode);
    }

    this.thermo.updateCharacteristic(C.CurrentHeatingCoolingState, curMode);
    this.thermo.updateCharacteristic(C.TargetHeatingCoolingState,  tgtMode);

    this.fanSvc.updateCharacteristic(C.On, s.powerSwitch === 1);
    this.fanSvc.updateCharacteristic(
      C.RotationSpeed,
      s.powerSwitch ? this.windToPercent(s.windSpeed) : 0
    );
  }

  // Helpers.

  // Device workMode -> HomeKit mode.
  workModeToHk(workMode) {
    const C = this.hap.Characteristic;
    switch (workMode) {
      case MODE.COOL: return C.TargetHeatingCoolingState.COOL;  // 1 -> COOL
      case MODE.HEAT: return C.TargetHeatingCoolingState.HEAT;  // 4 -> HEAT
      case MODE.AUTO: return C.TargetHeatingCoolingState.AUTO;  // 0 -> AUTO
      case MODE.DRY:  return C.TargetHeatingCoolingState.COOL;  // 2 -> closest HomeKit mode
      case MODE.FAN:  return C.TargetHeatingCoolingState.AUTO;  // 3 -> closest HomeKit mode
      default:        return C.TargetHeatingCoolingState.OFF;
    }
  }

  // Device windSpeed -> HomeKit percentage.
  // 0%    -> Auto        (windSpeed 0)
  // 12.5% -> Silent      (windSpeed 2)
  // 25%   -> Low         (windSpeed 2)
  // 37.5% -> Medium-low  (windSpeed 3)
  // 50%   -> Medium      (windSpeed 4)
  // 62.5% -> Medium-high (windSpeed 5)
  // 75%   -> High        (windSpeed 6)
  // 87.5% -> Turbo       (windSpeed 6)
  windToPercent(wind) {
    switch (wind) {
      case 0: return 0;     // Auto
      case 2: return 12.5;  // Silent / Low
      case 3: return 37.5;  // Medium-low
      case 4: return 50;    // Medium
      case 5: return 62.5;  // Medium-high
      case 6: return 87.5;  // High / Turbo
      default: return 0;
    }
  }

  // HomeKit percentage -> device windSpeed.
  percentToWind(pct) {
    if (pct <= 0)    return 0;  // Auto
    if (pct <= 25)   return 2;  // Silent / Low
    if (pct <= 37.5) return 3;  // Medium-low
    if (pct <= 50)   return 4;  // Medium
    if (pct <= 62.5) return 5;  // Medium-high
    return 6;                    // High / Turbo
  }

  // Send a command with retries.
  async sendWithRetry(props, ctx) {
    for (let i = 1; i <= 3; i++) {
      const ok = await this.api.sendCommand(this.device.deviceId, props);
      if (ok) {
        setTimeout(async () => {
          try {
            const ns = await this.api.getDeviceState(this.device.deviceId, true);
            if (ns) this.updateFromState(ns);
          } catch(e) {}
        }, 2000);
        return true;
      }
      this.log.warn(`${ctx} attempt ${i}/3 failed`);
      if (i < 3) await new Promise(r => setTimeout(r, 2000 * i));
    }
    this.log.error(`${ctx} failed after 3 attempts`);
    return false;
  }

  // Poll every three seconds.
  startPolling() {
    setInterval(async () => {
      try {
        const force = Date.now() - this._lastOkPoll > 10000;
        const s     = await this.api.getDeviceState(this.device.deviceId, force);
        if (s) {
          this._errCount   = 0;
          this._lastOkPoll = Date.now();
          this.updateFromState(s);
        }
      } catch (err) {
        this._errCount++;
        const isAuthErr = err.message.includes('Forbidden')
                       || err.message.includes('expired')
                       || err.message.includes('InvalidToken');
        if (isAuthErr || this._errCount >= 3) {
          this.log.warn('Re-authenticating...');
          await this.api.reAuth();
          this._errCount = 0;
        }
      }
    }, 3000);

    // Invalidate stale cache entries.
    setInterval(() => {
      const cached = this.api.stateCache[this.device.deviceId];
      if (cached && Date.now() - cached.lastUpdated > 45000) {
        delete this.api.stateCache[this.device.deviceId];
        this.api.dbg('Cache cleared');
      }
    }, 30000);
  }
}
