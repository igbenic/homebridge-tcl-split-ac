const test = require('node:test');
const assert = require('node:assert/strict');

const { _internals } = require('../index.js');

const {
  MODE,
  WIND,
  TCL_FEATURE_CONTROLS,
  featureControlIsActive,
  featureControlCommand,
  windToPercent,
  percentToWind,
} = _internals;

function control(key) {
  return TCL_FEATURE_CONTROLS.find(item => item.key === key);
}

test('fan speed helpers map HomeKit percentage to TCL windSpeed', () => {
  assert.equal(percentToWind(0), WIND.AUTO);
  assert.equal(percentToWind(12.5), WIND.SILENT);
  assert.equal(percentToWind(37.5), WIND.MED_LOW);
  assert.equal(percentToWind(50), WIND.MED);
  assert.equal(percentToWind(62.5), WIND.MED_HIGH);
  assert.equal(percentToWind(75), WIND.HIGH);

  assert.equal(windToPercent(WIND.AUTO), 0);
  assert.equal(windToPercent(WIND.SILENT), 12.5);
  assert.equal(windToPercent(WIND.MED_LOW), 37.5);
  assert.equal(windToPercent(WIND.MED), 50);
  assert.equal(windToPercent(WIND.MED_HIGH), 62.5);
  assert.equal(windToPercent(WIND.HIGH), 87.5);
});

test('dry mode switch powers on dry mode without changing target temperature', () => {
  const command = featureControlCommand(control('dryMode'), true, {
    powerSwitch: 0,
    workMode: MODE.COOL,
    windSpeed: WIND.MED,
    targetTemperature: 26,
  });

  assert.deepEqual(command, {
    powerSwitch: 1,
    workMode: MODE.DRY,
    windSpeed: WIND.MED,
    targetCelsiusDegree: 26,
    targetTemperature: 26,
  });
});

test('mode switches return to cool only when their mode is currently active', () => {
  assert.deepEqual(featureControlCommand(control('dryMode'), false, {
    powerSwitch: 1,
    workMode: MODE.DRY,
    windSpeed: WIND.AUTO,
    targetTemperature: 24,
  }), {
    powerSwitch: 1,
    workMode: MODE.COOL,
    windSpeed: WIND.AUTO,
    targetCelsiusDegree: 24,
    targetTemperature: 24,
  });

  assert.equal(featureControlCommand(control('dryMode'), false, {
    powerSwitch: 1,
    workMode: MODE.COOL,
    targetTemperature: 24,
  }), undefined);
});

test('fan-only switch reflects power and workMode together', () => {
  assert.equal(featureControlIsActive(control('fanOnlyMode'), {
    powerSwitch: 1,
    workMode: MODE.FAN,
  }), true);

  assert.equal(featureControlIsActive(control('fanOnlyMode'), {
    powerSwitch: 0,
    workMode: MODE.FAN,
  }), false);
});

test('boolean feature switches map directly to TCL shadow fields', () => {
  assert.deepEqual(featureControlCommand(control('ecoMode'), true, {}), { ECO: 1 });
  assert.deepEqual(featureControlCommand(control('ecoMode'), false, {}), { ECO: 0 });
  assert.equal(featureControlIsActive(control('ecoMode'), { ECO: 1 }), true);
  assert.equal(featureControlIsActive(control('ecoMode'), { ECO: 0 }), false);
});
