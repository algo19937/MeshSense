import { SerialPort } from "serialport";
import { create, toBinary } from "@bufbuild/protobuf";
import { MeshDevice, Protobuf, Types } from "../meshtastic-js/dist";

/** Meshtastic serial framing header bytes */
const HEADER = [0x94, 0xc3];

export interface NodeSerialConnectionParameters {
  /** Serial port path, e.g. /dev/ttyACM0, /dev/ttyUSB0, COM3 */
  path: string;
  /** Baud rate — Meshtastic devices use 115200 */
  baudRate?: number;
}

/**
 * Allows connecting to a Meshtastic device over a native Node.js serial port.
 * Uses the `serialport` npm package instead of the WebSerial browser API,
 * making it suitable for use in the MeshSense API backend.
 *
 * Meshtastic serial framing format:
 *   [0x94] [0xC3] [len_hi] [len_lo] [...protobuf payload]
 */
export class NodeSerialConnection extends MeshDevice {
  public connType: Types.ConnectionTypeName = "serial";

  protected portId: string = "";

  private serialPort: SerialPort | undefined;

  /** Accumulates raw bytes from the serial stream */
  private rxBuffer: Buffer = Buffer.alloc(0);

  /* Reference for the heartbeat ping interval so it can be canceled on disconnect. */
  private heartbeatInterval: ReturnType<typeof setInterval> | undefined;

  /** 連續 heartbeat 失敗次數，達到閾值才升級為 WARN */
  private heartbeatFailCount: number = 0;

  /** 連續失敗幾次才升級為 WARN（預設 3 次） */
  private readonly HEARTBEAT_WARN_THRESHOLD = 3;

  constructor(configId?: number) {
    super(configId);
    this.log = this.log.getSubLogger({ name: "NodeSerialConnection" });
    this.log.debug(
      Types.Emitter[Types.Emitter.Constructor],
      "🔷 NodeSerialConnection instantiated",
    );
  }

  /**
   * Initiates the connect process to a Meshtastic device via native serial port.
   * Accepts ConnectionParameters to satisfy the MeshDevice abstract signature,
   * but casts internally to NodeSerialConnectionParameters.
   */
  public async connect(
    parameters: Types.ConnectionParameters,
  ): Promise<void> {
    const { path, baudRate = 115200 } = parameters as unknown as NodeSerialConnectionParameters;
    this.updateDeviceStatus(Types.DeviceStatusEnum.DeviceConnecting);
    this.portId = path;

    // ── Open serial port ──────────────────────────────────────────────────
    try {
      this.serialPort = new SerialPort({ path, baudRate, autoOpen: false });
    } catch (e: unknown) {
      this.log.error(
        Types.Emitter[Types.Emitter.Connect],
        `❌ Failed to create serial port: ${e instanceof Error ? e.message : String(e)}`,
      );
      this.updateDeviceStatus(Types.DeviceStatusEnum.DeviceDisconnected);
      return;
    }

    await new Promise<void>((resolve, reject) => {
      this.serialPort!.open((err) => {
        if (err) reject(err);
        else resolve();
      });
    }).catch((e: Error) => {
      this.log.error(
        Types.Emitter[Types.Emitter.Connect],
        `❌ Failed to open serial port ${path}: ${e.message}`,
      );
      this.updateDeviceStatus(Types.DeviceStatusEnum.DeviceDisconnected);
      this.serialPort = undefined;
    });

    if (!this.serialPort?.isOpen) return;

    this.log.info(
      Types.Emitter[Types.Emitter.Connect],
      `✅ Serial port ${path} opened at ${baudRate} baud`,
    );

    // ── Passive disconnect handler ────────────────────────────────────────
    /**
     * FIX: Clear heartbeat on passive disconnect so the interval doesn't
     * keep firing after the device is physically unplugged.
     */
    this.serialPort.on("close", () => {
      this.log.info(
        Types.Emitter[Types.Emitter.Connect],
        "Device disconnected",
      );
      this._clearHeartbeat();
      this.updateDeviceStatus(Types.DeviceStatusEnum.DeviceDisconnected);
      this.complete();
    });

    this.serialPort.on("error", (e: Error) => {
      this.log.error(
        Types.Emitter[Types.Emitter.Connect],
        `❌ Serial port error: ${e.message}`,
      );
    });

    // ── Incoming data handler ─────────────────────────────────────────────
    this.rxBuffer = Buffer.alloc(0);
    this.serialPort.on("data", (chunk: Buffer) => {
      this.rxBuffer = Buffer.concat([this.rxBuffer, chunk]);
      this._processBuffer();
    });

    // ── Start device configuration ────────────────────────────────────────
    this.updateDeviceStatus(Types.DeviceStatusEnum.DeviceConnected);

    this.configure().catch(() => {
      // TODO: FIX, workaround for `wantConfigId` not getting acks.
    });

    // Heartbeat every 60 seconds — firmware requires at least one per 15 min.
    // Use writeToRadio() directly instead of heartbeat() to bypass the queue's
    // ACK-wait mechanism — firmware never ACKs heartbeat packets, so heartbeat()
    // always times out after 60 s and the fail counter can never reset.
    this.heartbeatInterval = setInterval(() => {
      const payload = toBinary(
        Protobuf.Mesh.ToRadioSchema,
        create(Protobuf.Mesh.ToRadioSchema, {
          payloadVariant: { case: "heartbeat", value: {} },
        }),
      );
      this.writeToRadio(payload)
        .then(() => {
          this.heartbeatFailCount = 0;
        })
        .catch((e: unknown) => {
          this.heartbeatFailCount++;
          const msg = e instanceof Error ? e.message : String(e);

          if (this.heartbeatFailCount >= this.HEARTBEAT_WARN_THRESHOLD) {
            this.log.warn(
              Types.Emitter[Types.Emitter.Connect],
              `⚠️ Heartbeat timed out or failed: ${msg}`,
            );
            this.heartbeatFailCount = 0;
          } else {
            this.log.debug(
              Types.Emitter[Types.Emitter.Connect],
              `❤️ Heartbeat failed (${this.heartbeatFailCount}/${this.HEARTBEAT_WARN_THRESHOLD}): ${msg}`,
            );
          }
        });
    }, 60 * 1000);
  }

  /** Disconnects from the serial port and releases all resources. */
  public disconnect(): void {
    this._clearHeartbeat();
    this.heartbeatFailCount = 0;

    if (this.serialPort?.isOpen) {
      this.serialPort.close((err) => {
        if (err) {
          this.log.error(
            Types.Emitter[Types.Emitter.Connect],
            `❌ Error closing serial port: ${err.message}`,
          );
        }
      });
    }

    this.serialPort = undefined;
    this.updateDeviceStatus(Types.DeviceStatusEnum.DeviceDisconnected);
    this.complete();
  }

  /** Pings device to check if it is available. */
  public async ping(): Promise<boolean> {
    return Promise.resolve(this.serialPort?.isOpen ?? false);
  }

  /**
   * Sends supplied protobuf message to the radio.
   * Meshtastic serial framing: [0x94] [0xC3] [len_hi] [len_lo] [...payload]
   */
  protected async writeToRadio(data: Uint8Array): Promise<void> {
    if (!this.serialPort?.isOpen) {
      this.log.error(
        Types.Emitter[Types.Emitter.WriteToRadio],
        "❌ Serial port is not open",
      );
      return;
    }

    const lenHi = (data.length >> 8) & 0xff;
    const lenLo = data.length & 0xff;
    const frame = Buffer.from([...HEADER, lenHi, lenLo, ...data]);

    await new Promise<void>((resolve, reject) => {
      this.serialPort!.write(frame, (err) => {
        if (err) reject(err);
        else resolve();
      });
    }).catch((e: Error) => {
      this.log.error(
        Types.Emitter[Types.Emitter.WriteToRadio],
        `❌ Write error: ${e.message}`,
      );
    });
  }

  // ── Private helpers ───────────────────────────────────────────────────────

  /**
   * Parses accumulated rx bytes looking for complete Meshtastic frames.
   * Frame format: [0x94] [0xC3] [len_hi] [len_lo] [...payload (len bytes)]
   * Discards any leading bytes that don't match the header.
   */
  private _processBuffer(): void {
    while (this.rxBuffer.length >= 4) {
      // Find the start of a valid frame header
      const headerIdx = this._findHeader();
      if (headerIdx === -1) {
        // No header found — keep last byte in case it's the start of next header
        this.rxBuffer = this.rxBuffer.slice(this.rxBuffer.length - 1);
        return;
      }

      // Discard bytes before the header
      if (headerIdx > 0) {
        this.rxBuffer = this.rxBuffer.slice(headerIdx);
      }

      // Need at least 4 bytes for header + length
      if (this.rxBuffer.length < 4) return;

      const lenHi = this.rxBuffer[2] ?? 0;
      const lenLo = this.rxBuffer[3] ?? 0;
      const payloadLen = (lenHi << 8) | lenLo;

      // Sanity check — Meshtastic packets are never larger than 512 bytes
      if (payloadLen === 0 || payloadLen > 512) {
        this.log.warn(
          Types.Emitter[Types.Emitter.ReadFromRadio],
          `⚠️ Invalid payload length ${payloadLen}, skipping header`,
        );
        this.rxBuffer = this.rxBuffer.slice(2);
        continue;
      }

      const totalLen = 4 + payloadLen;
      if (this.rxBuffer.length < totalLen) {
        // Incomplete frame — wait for more data
        return;
      }

      const payload = this.rxBuffer.slice(4, totalLen);
      this.rxBuffer = this.rxBuffer.slice(totalLen);

      this.handleFromRadio(new Uint8Array(payload));
      this.updateDeviceStatus(Types.DeviceStatusEnum.DeviceConnected);
    }
  }

  /** Returns the index of the first valid [0x94, 0xC3] header, or -1. */
  private _findHeader(): number {
    for (let i = 0; i < this.rxBuffer.length - 1; i++) {
      if (this.rxBuffer[i] === HEADER[0] && this.rxBuffer[i + 1] === HEADER[1]) {
        return i;
      }
    }
    return -1;
  }

  /** Clears the heartbeat interval if it is active. */
  private _clearHeartbeat(): void {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = undefined;
    }
  }
}
