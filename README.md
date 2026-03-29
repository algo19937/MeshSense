# MeshSense (Serial Fork)

[繁體中文](README.zh-TW.md) | **English**

A fork of [MeshSense](https://github.com/Affirmatech/MeshSense) that adds native USB Serial connection support for Meshtastic devices in the Node.js backend.

---

## What's new

The original MeshSense connects to Meshtastic devices via **BLE** or **HTTP/IP**.  
While `meshtastic-js` includes a `serialConnection.ts`, it is built on the browser's WebSerial API and cannot run server-side.

This fork adds `NodeSerialConnection` — a backend Serial adapter that connects directly to the device over USB using the Node.js `serialport` package, with no browser dependency.

### Connection comparison

| | BLE | HTTP/IP | Serial (this fork) |
|---|---|---|---|
| Connect time | ~30s | ~5s | **~3s** |
| Stability | Good | Good | **Excellent** |
| Requirement | Pairing | Network | USB cable |
| Tested uptime | — | — | **14h+ no drops** |

---

## Changes from upstream

### New file

**`api/src/nodeSerialConnection.ts`**

A Node.js Serial adapter extending `MeshDevice`. Implements Meshtastic's binary framing protocol over a raw serial byte stream:

```
[0x94] [0xC3] [len_hi] [len_lo] [protobuf payload]
```

- Stream reassembly for fragmented packets (buffer up to 512 bytes)
- Passive disconnect detection — clears heartbeat when device is unplugged
- 60-second keepalive heartbeat (firmware requires contact within 15 minutes)
- Clean resource release on disconnect

### Modified files

**`api/src/meshtastic.ts`**
- Added `import { NodeSerialConnection }`
- Extended connection type: `HttpConnection | BleConnection | NodeSerialConnection`
- Added `validateSerialPort()` to detect Serial path format
- Added Serial branch in `connect()`: BLE → Serial → HTTP

**`api/meshtastic-js/tsup.config.ts`**
- Added `serialport` to `external` to prevent native addon bundling issues

**`api/meshtastic-js/src/adapters/index.ts`**
- Removed `nodeSerialConnection` export to keep the `meshtastic-js` build clean

---

## Getting started

### Requirements

- Node.js v18+
- A Meshtastic device connected via USB

### Install & run

```bash
git clone --recurse-submodules https://github.com/algo19937/MeshSense
cd MeshSense
```

Build the `webbluetooth` dependency. Debian-based systems require `cmake` and `libdbus-1-dev`:

```bash
sudo apt install cmake libdbus-1-dev   # Debian/Ubuntu only
cd api/webbluetooth
npm i
npm run build:all
cd ../..
```

Pull latest dependencies for `ui`, `api`, and `electron`:

```bash
./update.mjs
```

Start the UI Vite service first in one terminal (Electron is not required during development):

```bash
cd ui
PORT=5921 npm run dev
```

Then start the API backend in a separate terminal:

```bash
cd api
export DEV_UI_URL=http://localhost:5921
PORT=5920 npm run dev
```

Open your browser at `http://localhost:5920`.

### Connect

Enter the Serial port path in the **Address** field and click **Connect**:

```
/dev/ttyACM0
```

### Supported path formats

| Format | Example | Platform |
|---|---|---|
| `/dev/ttyACM*` | `/dev/ttyACM0` | Linux — USB CDC ACM |
| `/dev/ttyUSB*` | `/dev/ttyUSB0` | Linux — USB-Serial adapter |
| `/dev/ttyAMA*` | `/dev/ttyAMA0` | Raspberry Pi UART |
| `/dev/ttyS*` | `/dev/ttyS0` | Linux built-in UART |
| `COM*` | `COM3` | Windows |

### Linux serial port permission

If the port is not accessible, add your user to the `dialout` group:

```bash
sudo usermod -aG dialout $USER
# Log out and back in for this to take effect
```

---

## Known limitations

- **AppImage packaging**: `serialport` contains a native addon whose ABI differs between system Node.js and Electron. Packaging as AppImage requires replacing `serialport` with a TCP proxy approach. This is planned for a future release.

---

## BLE stability fixes (also included)

This fork also incorporates fixes for BLE connection stability (`bleConnection.ts`):

- FIX #1: `Promise.all()` for characteristic discovery (was `.map()`)
- FIX #2: `pendingRead` guard to prevent concurrent GATT reads
- FIX #3: Clear polling timer on passive disconnect
- FIX #4: Remove redundant `readFromRadio()` after write
- FIX #5: Surface connection failures via device status update
- FIX #6: Guard against `undefined` returned by `readValue()`
- FIX #7: `isScanning` guard to prevent concurrent BLE scan requests

Result: BLE connections previously dropped every few minutes now run stably for 3+ hours.

---

## Origin

Forked from **[Affirmatech/MeshSense](https://github.com/Affirmatech/MeshSense)**.  
All original work and copyright belong to the upstream authors.

## License

GPL-3.0 — same as the upstream project. See [LICENSE](LICENSE).
