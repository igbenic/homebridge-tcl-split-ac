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
- Switch modes: Auto, Cool, Heat
- Fan speed control
- Current temperature display
- Siri and Apple Home app support through Homebridge

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
