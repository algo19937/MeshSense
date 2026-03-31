# MeshSense（Serial 擴充版）

**繁體中文** | [English](README.md)

本專案 Fork 自 [MeshSense](https://github.com/Affirmatech/MeshSense)，在 Node.js 後端新增原生 USB Serial 連線支援。

---

## 新增功能

原始 MeshSense 支援透過 **BLE（藍牙）** 或 **HTTP/IP** 連線 Meshtastic 設備。
`meshtastic-js` 雖然已有 `serialConnection.ts`，但該實作基於瀏覽器的 WebSerial API，無法在 Node.js 後端環境執行。

本 Fork 新增兩項主要功能：

- **`NodeSerialConnection`**：使用 Node.js `serialport` 套件直接透過 USB 連線設備，完全不依賴瀏覽器 API。
- **TCP Proxy**：開放 Meshtastic serial-over-TCP 伺服器（預設 port 4403），允許 Meshtastic CLI 等多個外部客戶端同時連線，封包雙向轉發。

### 連線方式比較

| | BLE | HTTP/IP | Serial（本 Fork 新增）|
|---|---|---|---|
| 連線建立時間 | 約 30 秒 | 約 5 秒 | **約 3 秒** |
| 穩定性 | 良好 | 良好 | **極佳** |
| 需求 | 藍牙配對 | 網路連線 | USB 連接線 |
| 實測連線時長 | — | — | **14 小時以上，零斷線** |

---

## 與原版的差異

### 新增檔案

**`api/src/nodeSerialConnection.ts`**

繼承 `MeshDevice` 的 Node.js Serial 連線實作，處理 Meshtastic 的 Serial framing 協議：

```
[0x94] [0xC3] [len_hi] [len_lo] [protobuf payload]
```

- 支援不完整封包的串流重組（緩衝區上限 512 bytes）
- 被動斷線偵測——設備拔除時自動清除心跳計時器
- 每 60 秒發送 keepalive 心跳（韌體要求 15 分鐘內至少聯繫一次）
- 斷線時完整釋放資源

**`api/src/lib/tcpProxy.ts`**

TCP 伺服器，實作 Meshtastic serial-over-TCP 協議（與 Serial 相同的 `[0x94][0xC3][len_hi][len_lo][payload]` framing）：

- 支援多個 TCP 客戶端同時連線
- 將 radio 收到的所有 `FromRadio` 封包廣播給每個 TCP 客戶端
- 將 TCP 客戶端傳入的 `ToRadio` 封包透過 `connection.sendRaw()` 轉發至 radio，相容 Serial、HTTP、BLE 三種後端
- 可從 Settings UI 開關與設定 port，即時顯示連線中的客戶端數

### 修改檔案

**`api/src/meshtastic.ts`**
- 新增 `import { NodeSerialConnection }`
- 連線型別擴充：`HttpConnection | BleConnection | NodeSerialConnection`
- 新增 `validateSerialPort()` 自動識別 Serial port 路徑格式
- `connect()` 新增 Serial 分支，判斷順序：BLE → Serial → HTTP
- 新增 TCP Proxy 生命週期管理（設定變更時啟動/停止，port 變更時自動重啟）
- `onFromRadio` 事件廣播至所有已連線的 TCP 客戶端

**`api/src/vars.ts`**
- 新增 `tcpProxyEnabled`、`tcpProxyPort`（預設 `4403`）、`tcpProxyClients` 狀態變數

**`ui/src/Settings.svelte`**
- 新增 TCP Proxy 控制元件：開關、port 輸入、即時客戶端數顯示、CLI 連線指令提示

**`ui/vite.config.ts`** / **`ui/tsconfig.json`**
- 新增 Vite alias 與 TypeScript `paths`，將 `api/src` 直接對應至 `../api/src`，確保 UI 建置永遠讀取最新的 API 源碼，不再依賴 `node_modules/api/` 的同步狀態

**`api/meshtastic-js/tsup.config.ts`**
- 將 `serialport` 加入 `external`，避免 native addon 打包路徑問題

**`api/meshtastic-js/src/adapters/index.ts`**
- 移除 `nodeSerialConnection` 的 export，避免 `meshtastic-js` build 時處理 serialport 依賴

---

## 使用方式

### 環境需求

- Node.js v18 以上
- Meshtastic 設備透過 USB 連接至電腦

### 安裝與啟動

```bash
git clone --recurse-submodules https://github.com/algo19937/MeshSense
cd MeshSense
```

建置 `webbluetooth` 依賴套件。Debian 系列系統需要先安裝 `cmake` 與 `libdbus-1-dev`：

```bash
sudo apt install cmake libdbus-1-dev   # Debian/Ubuntu 限定
cd api/webbluetooth
npm i
npm run build:all
cd ../..
```

更新 `ui`、`api`、`electron` 的依賴套件：

```bash
./update.mjs
```

先在第一個終端機啟動 UI Vite 服務（開發時不需要 Electron）：

```bash
cd ui
PORT=5921 npm run dev
```

再開第二個終端機啟動 API 後端：

```bash
cd api
export DEV_UI_URL=http://localhost:5921
PORT=5920 npm run dev
```

瀏覽器開啟 `http://localhost:5920`。

### 打包 AppImage（Linux）

使用專案提供的建置腳本，會依序執行所有必要步驟：

```bash
./build.mjs
# 輸出：electron/dist/meshsense-beta-x86_64.AppImage
```

腳本執行順序：UI 建置 → API 打包 → electron-builder。
直接在 `electron/` 目錄執行 `npm run build:linux` 會失敗，因為 `electron/resources/api/index.cjs` 不在 git 中，必須先由 API 建置步驟產生。

### 連線

在 MeshSense 的 **Address** 欄位輸入 Serial port 路徑，點擊 **Connect**：

```
/dev/ttyACM0
```

### 支援的路徑格式

| 格式 | 範例 | 平台 |
|---|---|---|
| `/dev/ttyACM*` | `/dev/ttyACM0` | Linux — USB CDC ACM |
| `/dev/ttyUSB*` | `/dev/ttyUSB0` | Linux — USB-Serial 轉接器 |
| `/dev/ttyAMA*` | `/dev/ttyAMA0` | 樹莓派 UART |
| `/dev/ttyS*` | `/dev/ttyS0` | Linux 內建 UART |
| `COM*` | `COM3` | Windows |

### Linux Serial port 權限

若無法存取 Serial port，將使用者加入 `dialout` 群組：

```bash
sudo usermod -aG dialout $USER
# 重新登入後生效
```

### TCP Proxy

MeshSense 可開放 TCP 伺服器，讓 Meshtastic CLI 等工具與 UI 同時連線。

1. 開啟 **Settings**，啟用 **TCP Proxy**。預設 port 為 `4403`。
2. 使用任何相容 Meshtastic 的客戶端連線：

```bash
# 預設 port 4403，不需要加 --port 參數
meshtastic --host <MeshSense主機IP> --nodes

# 自訂 port，使用 host:port 格式
meshtastic --host <MeshSense主機IP>:4404 --nodes

# 範例
meshtastic --host 192.168.1.100 --nodes
meshtastic --host 192.168.1.100 --sendtext "Hello"
```

> 注意：Meshtastic CLI 的 `--port` 參數是指 **serial port 路徑**（例如 `/dev/ttyACM0`），不是 TCP port 號碼，不可與 `--host` 同時使用。

多個客戶端可同時連線，UI 即時顯示目前連線數。

---

## BLE 穩定性修復（同步包含）

本 Fork 同時包含 BLE 連線穩定性修復（`bleConnection.ts`）：

- FIX #1：characteristic 探索改用 `Promise.all()`（原為 `.map()`）
- FIX #2：`pendingRead` 旗標防止並發 GATT 讀取
- FIX #3：被動斷線時清除輪詢計時器
- FIX #4：移除 write 後多餘的 `readFromRadio()` 呼叫
- FIX #5：連線失敗時正確更新設備狀態
- FIX #6：防範 `readValue()` 回傳 `undefined` 導致崩潰
- FIX #7：`isScanning` 旗標防止並發 BLE 掃描請求

修復結果：BLE 連線從原本每幾分鐘斷線一次，改善為可穩定運作 3 小時以上。

---

## 原始專案

本專案 Fork 自：**[Affirmatech/MeshSense](https://github.com/Affirmatech/MeshSense)**  
原始專案之著作權與所有貢獻歸原作者 Affirmatech 所有。

## 授權

本專案採用與原始專案相同的 **GNU General Public License v3.0**。  
詳細內容請參閱 [LICENSE](LICENSE) 檔案。
