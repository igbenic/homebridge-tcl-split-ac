# homebridge-tcl-split-ac

[![Homebridge](https://img.shields.io/badge/homebridge-plugin-blueviolet)](https://github.com/homebridge/homebridge)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

A [Homebridge](https://homebridge.io) plugin for controlling **TCL TAC-BR12INV** inverter split air conditioners through the TCL Home cloud and Apple HomeKit.

This is a maintained fork of `askarkurymbayev/homebridge-tcl-split-ac`. It keeps the package name as `homebridge-tcl-split-ac` so it can replace the npm package in an existing Homebridge setup.

## Status

- Fork maintenance is in progress.
- Runtime behavior is still based on the original plugin and has not yet been verified against every supported AC model.
- The plugin uses the TCL Home cloud account credentials from your Homebridge config.
- Devices are discovered from your TCL Home account automatically; no `deviceId` setting is used by the current code.

## Features

- Power on/off
- Set target temperature
- Switch thermostat modes: Auto, Cool, Heat
- Switch TCL-only modes: Dry and Fan Only
- Fan speed control with Auto/Manual fan state
- Swing control
- Eco, Sleep, Turbo, and Silence controls
- Current temperature display
- Siri and Apple Home app support through Homebridge

## HomeKit Mapping

The plugin exposes the AC as a HomeKit `Thermostat`, a separate `Fanv2` speed control, and additional HomeKit `Switch` services for TCL features that HomeKit does not model directly.

| TCL shadow field | HomeKit mapping | Status |
|------------------|-----------------|--------|
| `powerSwitch` | Thermostat off/active and Fan on/off | Implemented |
| `workMode` | Thermostat target mode: Off, Cool, Heat, Auto | Implemented |
| `workMode: 2` | Dry Mode switch | Implemented |
| `workMode: 3` | Fan Only Mode switch | Implemented |
| `currentTemperature` | Thermostat current temperature | Implemented |
| `targetCelsiusDegree` / `targetTemperature` | Thermostat target temperature | Implemented |
| `windSpeed` | Fanv2 rotation speed percentage and auto/manual fan state | Implemented |
| `verticalSwitch` / `horizontalSwitch` | Fanv2 swing mode | Implemented |
| `ECO` | Eco Mode switch | Implemented |
| `sleep` | Sleep Mode switch | Implemented |
| `turbo` | Turbo Mode switch | Implemented |
| `silenceSwitch` | Silence Mode switch | Implemented |

HomeKit exposes swing as a single on/off value. This fork maps swing-on to TCL vertical swing and maps swing-off to both vertical and horizontal swing off.

HomeKit does not have native Dry or Fan Only thermostat modes. This fork keeps the thermostat's standard Off/Cool/Heat/Auto mapping and exposes Dry Mode and Fan Only Mode as separate switches. Turning either switch on powers the AC and sets the matching TCL `workMode`; turning it off returns the AC to Cool only when that mode is currently active.

## Requirements

- Homebridge
- Node.js 20 or newer
- TCL TAC-BR12INV inverter air conditioner, or a compatible TCL Home cloud AC
- TCL Home app account

## Install This Fork

To replace the npm package with this fork in a global Homebridge installation:

```bash
npm uninstall -g homebridge-tcl-split-ac
npm install -g git+https://github.com/igbenic/homebridge-tcl-split-ac.git
hb-service restart
```

If your Homebridge installation requires elevated privileges, run the install commands with `sudo`.

## Configuration

Add this platform entry to Homebridge `config.json`:

```json
{
  "platforms": [
    {
      "platform": "TclHome",
      "name": "TCL Home",
      "username": "your@email.com",
      "password": "yourpassword",
      "debugMode": false
    }
  ]
}
```

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `platform` | string | Yes | Must be `TclHome`. |
| `name` | string | Yes | Display name for the Homebridge platform. |
| `username` | string | Yes | TCL Home account email address. |
| `password` | string | Yes | TCL Home account password. |
| `debugMode` | boolean | No | Enables verbose logs when troubleshooting. |

## Troubleshooting

- Confirm the TCL Home account credentials work in the TCL Home app.
- Make sure the AC is online and visible in TCL Home.
- Restart Homebridge after installing the fork.
- Check Homebridge logs with `debugMode` enabled if discovery or control fails.

## License

[MIT](LICENSE) (original project by Askar Kurymbayev).
