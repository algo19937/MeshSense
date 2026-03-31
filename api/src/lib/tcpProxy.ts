import { createServer, Server, Socket } from 'net'
import { Protobuf } from '../../meshtastic-js/dist'
import { toBinary, fromBinary } from '@bufbuild/protobuf'

const HEADER = [0x94, 0xc3]

/** Wrap a raw protobuf payload in Meshtastic serial framing */
function framePacket(payload: Uint8Array): Buffer {
  const lenHi = (payload.length >> 8) & 0xff
  const lenLo = payload.length & 0xff
  return Buffer.from([...HEADER, lenHi, lenLo, ...payload])
}

/** Manages one connected TCP client, parsing incoming frames and sending outgoing ones */
class TcpProxyClient {
  readonly socket: Socket
  private rxBuffer: Buffer = Buffer.alloc(0)
  private readonly onToRadio: (payload: Uint8Array) => void

  constructor(socket: Socket, onToRadio: (payload: Uint8Array) => void) {
    this.socket = socket
    this.onToRadio = onToRadio

    socket.on('data', (chunk: Buffer) => {
      this.rxBuffer = Buffer.concat([this.rxBuffer, chunk])
      this.processBuffer()
    })

    socket.on('error', (e: Error) => {
      console.error('[tcpProxy] Client socket error:', e.message)
    })
  }

  /** Send a FromRadio protobuf object to this client using Meshtastic serial framing */
  sendFromRadio(fromRadio: Protobuf.Mesh.FromRadio): void {
    if (this.socket.destroyed) return
    try {
      const payload = toBinary(Protobuf.Mesh.FromRadioSchema, fromRadio)
      this.socket.write(framePacket(payload))
    } catch (e) {
      console.error('[tcpProxy] Failed to encode FromRadio:', e)
    }
  }

  /** Parse accumulated bytes looking for complete Meshtastic frames (same framing as serial) */
  private processBuffer(): void {
    while (this.rxBuffer.length >= 4) {
      const headerIdx = this.findHeader()
      if (headerIdx === -1) {
        this.rxBuffer = this.rxBuffer.slice(this.rxBuffer.length - 1)
        return
      }

      if (headerIdx > 0) {
        this.rxBuffer = this.rxBuffer.slice(headerIdx)
      }

      if (this.rxBuffer.length < 4) return

      const lenHi = this.rxBuffer[2] ?? 0
      const lenLo = this.rxBuffer[3] ?? 0
      const payloadLen = (lenHi << 8) | lenLo

      if (payloadLen === 0 || payloadLen > 512) {
        this.rxBuffer = this.rxBuffer.slice(2)
        continue
      }

      const totalLen = 4 + payloadLen
      if (this.rxBuffer.length < totalLen) return

      const payload = new Uint8Array(this.rxBuffer.slice(4, totalLen))
      this.rxBuffer = this.rxBuffer.slice(totalLen)

      this.onToRadio(payload)
    }
  }

  private findHeader(): number {
    for (let i = 0; i < this.rxBuffer.length - 1; i++) {
      if (this.rxBuffer[i] === HEADER[0] && this.rxBuffer[i + 1] === HEADER[1]) return i
    }
    return -1
  }
}

/**
 * TCP server that exposes the Meshtastic serial-over-TCP protocol (default port 4403).
 * Multiple clients can connect simultaneously. Each receives all FromRadio frames
 * from the radio, and can send ToRadio frames which are forwarded to the radio.
 */
export class TcpProxy {
  private server: Server
  private clients: Set<TcpProxyClient> = new Set()
  private readonly port: number

  /** Set this before start() to forward ToRadio payloads from TCP clients to the radio */
  sendToRadio: ((payload: Uint8Array) => Promise<void>) | undefined

  /** Fired whenever the client count changes */
  onClientCountChange: ((count: number) => void) | undefined

  constructor(port: number) {
    this.port = port
    this.server = createServer((socket: Socket) => {
      console.log(`[tcpProxy] Client connected: ${socket.remoteAddress}:${socket.remotePort}`)

      const client = new TcpProxyClient(socket, async (payload) => {
        try {
          // Validate it's a parseable ToRadio before forwarding
          fromBinary(Protobuf.Mesh.ToRadioSchema, payload)
          await this.sendToRadio?.(payload)
        } catch (e) {
          console.error('[tcpProxy] Invalid ToRadio payload from client, dropping:', e)
        }
      })

      this.clients.add(client)
      this.onClientCountChange?.(this.clients.size)

      socket.on('close', () => {
        this.clients.delete(client)
        console.log(`[tcpProxy] Client disconnected: ${socket.remoteAddress}:${socket.remotePort}`)
        this.onClientCountChange?.(this.clients.size)
      })
    })

    this.server.on('error', (e: Error) => {
      console.error('[tcpProxy] Server error:', e.message)
    })
  }

  start(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server.listen(this.port, '0.0.0.0', () => {
        console.log(`[tcpProxy] Listening on port ${this.port}`)
        resolve()
      })
      this.server.once('error', reject)
    })
  }

  stop(): Promise<void> {
    return new Promise((resolve) => {
      for (const client of this.clients) {
        client.socket.destroy()
      }
      this.clients.clear()
      this.onClientCountChange?.(0)
      this.server.close(() => resolve())
    })
  }

  /** Forward a parsed FromRadio message to all connected TCP clients */
  broadcast(fromRadio: Protobuf.Mesh.FromRadio): void {
    for (const client of this.clients) {
      client.sendFromRadio(fromRadio)
    }
  }

  get clientCount(): number {
    return this.clients.size
  }
}
