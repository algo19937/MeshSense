# MeshSense（Serial 擴充版）

**繁體中文** | [English](README.md)

本專案 Fork 自 [MeshSense](https://github.com/Affirmatech/MeshSense)，在 Node.js 後端新增原生 USB Serial 連線支援。

---

## 新增功能

原始 MeshSense 支援透過 **BLE（藍牙）** 或 **HTTP/IP** 連線 Meshtastic 設備。  
`meshtastic-js` 雖然已有 `serialConnection.ts`，但該實作基於瀏覽器的 WebSerial API，無法在 Node.js 後端環境執行。

本 Fork 新增 `NodeSerialConnection`，使用 Node.js `serialport` 套件直接透過 USB 連線設備，完全不依賴瀏覽器 API。

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

### 修改檔案

**`api/src/meshtastic.ts`**
- 新增 `import { NodeSerialConnection }`
- 連線型別擴充：`HttpConnection | BleConnection | NodeSerialConnection`
- 新增 `validateSerialPort()` 自動識別 Serial port 路徑格式
- `connect()` 新增 Serial 分支，判斷順序：BLE → Serial → HTTP

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
git clone --recurse-submodules https://github.com/你的帳號/MeshSense.git
cd MeshSense

# 建置 meshtastic-js
cd api/meshtastic-js && npm install && npm run build && cd ../..

# 安裝並啟動
cd api && npm install
PORT=5920 npm run dev
```

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

---

## 已知限制

- **AppImage 打包**：`serialport` 含有 native addon，其 ABI 與 Electron 不相容，目前無法直接打包為 AppImage。計畫於後續版本改用 TCP proxy 方式解決此問題。

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
