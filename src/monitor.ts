import { Buffer } from 'node:buffer'
import { EventEmitter } from 'node:events'

import { createConnection, parseMessage } from './eventedHttpClient/index.js'
import { HapEvInstance, HapInstance, ServiceType } from './interfaces.js'

// Upper bound for the per-socket receive buffer. HAP EVENT messages are small
// JSON characteristic updates (well under a KB in practice); a buffer that
// grows past this without yielding a complete message means the peer sent
// malformed data or a Content-Length it never satisfies, so the connection is
// reset rather than retaining bytes indefinitely.
const MAX_RECV_BUFFER_BYTES = 2 * 1024 * 1024

/**
 * Locate the end of the next complete HTTP/EVENT message in `buffer`.
 * Returns -1 when the buffer does not yet contain a full message.
 */
export function findMessageBoundary(buffer: Buffer): number {
  // Decode as latin1 so one byte maps to exactly one character: string indices
  // are then identical to byte offsets. Content-Length is a byte count, so this
  // keeps the boundary maths correct even when the body contains multibyte
  // UTF-8 characters (e.g. a localised characteristic string value).
  const raw = buffer.toString('latin1')

  // Locate the blank line separating headers from body.
  const sepMatch = raw.match(/\r?\n\r?\n/)
  if (!sepMatch || sepMatch.index === undefined) {
    return -1
  }

  const headers = raw.slice(0, sepMatch.index)
  const bodyStart = sepMatch.index + sepMatch[0].length

  const contentLengthMatch = headers.match(/Content-Length:\s*(\d+)/i)
  if (!contentLengthMatch) {
    // No Content-Length means no body for HAP traffic on this socket: the
    // subscribe ACK is a bodyless 204, and every EVENT carries Content-Length
    // (HAP-NodeJS never uses chunked encoding here). End the message at the
    // header terminator so a following EVENT coalesced into the same TCP chunk
    // is not swallowed along with the ACK.
    return bodyStart
  }

  const messageEnd = bodyStart + Number(contentLengthMatch[1])
  if (buffer.length < messageEnd) {
    return -1
  }
  return messageEnd
}

/**
 * HapMonitor - Creates a monitor to watch for changes in accessory characteristics.  And generates 'service-update' events when they change.
 */
export class HapMonitor extends EventEmitter {
  /**
   * Resolves the pin to use for a given bridge. A plain string is still
   * accepted and means "this pin for every instance", which is what the
   * monitor assumed before child bridges could carry their own pin.
   */
  private readonly pinFor: (instance: { username?: string }) => string
  private readonly evInstances: HapEvInstance[]
  private readonly services: ServiceType[]
  private logger: any
  private readonly debug: (arg0: string) => void

  constructor(
    logger: any,
    debug: any,
    pin: string | ((instance: { username?: string }) => string),
    services: ServiceType[],
  ) {
    super()
    this.logger = logger
    this.debug = debug
    this.pinFor = typeof pin === 'function' ? pin : () => pin
    this.services = services
    this.evInstances = [] as HapEvInstance[]

    // get a list of characteristics we can watch for each instance
    this.parseServices()

    // start watching
    this.start()
  }

  log(message: string) {
    this.logger?.log(`[HapMonitor] ${message}`)
  }

  error(message: string) {
    if (typeof this.logger?.error === 'function') {
      this.logger.error(`[HapMonitor] ${message}`)
    } else {
      this.logger?.log?.(`[HapMonitor] ERROR: ${message}`)
    }
  }

  start() {
    for (const instance of this.evInstances) {
      this.connectInstance(instance)
    }
  }

  connectInstance(instance: HapEvInstance) {
    try {
      this.debug(`[HapClient] [${instance.ipAddress}:${instance.port} (${instance.username})] Connecting`)
      instance.socket = createConnection(instance, this.pinFor(instance), { characteristics: instance.evCharacteristics })
      instance.monitoring = true
      instance.recvBuffer = Buffer.alloc(0)

      this.debug(`[HapClient] [${instance.ipAddress}:${instance.port} (${instance.username})] Connected`)

      instance.socket.on('data', (data) => {
        // Accumulate raw bytes. Decoding per-chunk would corrupt a multibyte
        // UTF-8 character that happens to be split across two TCP packets.
        const chunk = Buffer.isBuffer(data) ? data : Buffer.from(data)
        instance.recvBuffer = instance.recvBuffer?.length
          ? Buffer.concat([instance.recvBuffer, chunk])
          : chunk

        // Several HAP EVENT messages can arrive in a single TCP chunk on busy
        // bridges, and a single message can also be split across packets. Pull
        // complete messages off the front of the buffer one at a time. The
        // boundary is a byte offset, so decode each complete message only once
        // it has been sliced out whole.
        while (true) {
          const boundary = findMessageBoundary(instance.recvBuffer)
          if (boundary <= 0) {
            break
          }
          const messageStr = instance.recvBuffer.subarray(0, boundary).toString()
          instance.recvBuffer = instance.recvBuffer.subarray(boundary)
          this.handleEventMessage(instance, messageStr)
        }

        // If, after draining every complete message, the remaining buffer is
        // still over the cap, no valid message is forming (malformed peer or an
        // unsatisfiable Content-Length). Drop it and tear the socket down so the
        // existing 'close' path can recover, rather than growing without bound.
        if ((instance.recvBuffer?.length ?? 0) > MAX_RECV_BUFFER_BYTES) {
          this.error(`[${instance.ipAddress}:${instance.port} (${instance.username})] `
            + `receive buffer exceeded ${MAX_RECV_BUFFER_BYTES} bytes without a complete message; resetting connection`)
          instance.recvBuffer = Buffer.alloc(0)
          instance.socket.destroy()
        }
      })
      instance.socket.on('close', (hadError) => {
        this.emit('monitor-close', instance, hadError)
        instance.socket.destroy()
        instance.socket.removeAllListeners()
        this.debug(`[HapClient] [${instance.ipAddress}:${instance.port} (${instance.username})] closed: ${hadError}`)
      })
      instance.socket.on('error', (error) => { // Even though this is redundant with the close event, it's necessary to catch the error event here
        this.emit('monitor-error', instance, error)
        this.debug(`[HapClient] [${instance.ipAddress}:${instance.port} (${instance.username})] error: ${error}`)
      })
    } catch (e) {
      this.debug(e)

      this.error(`Monitor Start Error [${instance.ipAddress}:${instance.port} (${instance.username})]: ${e.message}`)
    }
  }

  finish() {
    for (const instance of this.evInstances) {
      if (instance.socket) {
        try {
          instance.socket.destroy()
          instance.socket.removeAllListeners()
          this.debug(`[HapClient] [${instance.ipAddress}:${instance.port} (${instance.username})] Disconnected`)
        } catch {
          // do nothing
        }
      }
    }
  }

  refreshMonitorConnection(refreshInstance: HapEvInstance) {
    this.debug(`[HapClient] [${refreshInstance.ipAddress}:${refreshInstance.port} (${refreshInstance.username})] Refreshing Monitor`)
    // console.log('this.evInstances', this.evInstances);
    const instance = this.evInstances.find(x => x.username === refreshInstance.username)
    if (instance) {
      instance.socket?.destroy()
      instance.socket?.removeAllListeners()
      instance.port = refreshInstance.port
      instance.ipAddress = refreshInstance.ipAddress

      this.connectInstance(instance)
      this.emit('monitor-refresh', instance)
    }
  }

  /**
   * Returns true if the instance is being monitored (i.e. has an active socket or is in the process of reconnecting) for the
   * given instance username, false otherwise.
   */
  isInstanceMonitored(username: string): boolean {
    const instance = this.evInstances.find(x => x.username === username)
    return instance?.monitoring === true
  }

  /**
   * Returns true if the monitor has an active (non-destroyed) socket for the
   * given instance username, false otherwise.
   */
  isInstanceConnected(username: string): boolean {
    const instance = this.evInstances.find(x => x.username === username)
    return instance?.socket != null && instance?.socket !== undefined && !instance.socket.destroyed
  }

  private handleEventMessage(instance: HapEvInstance, messageStr: string) {
    const message = parseMessage(messageStr)

    if (message.statusCode === 401) {
      this.debug(`[HapClient] [${instance.ipAddress}:${instance.port} (${instance.username})] `
        + `${message.statusCode} ${message.statusMessage} - make sure Homebridge pin for this instance is set to ${this.pinFor(instance)}.`)
    }

    if (message.protocol === 'EVENT') {
      try {
        const body = JSON.parse(message.body)
        if (body.characteristics && body.characteristics.length) {
          this.debug(`[HapClient] [${instance.ipAddress}:${instance.port} (${instance.username})] `
            + `Got Event: ${JSON.stringify(body.characteristics)}`)

          const response = body.characteristics.map((c) => {
            // find the matching service for each characteristic
            const services = this.services.filter(x => x.aid === c.aid && x.instance.username === instance.username)
            const service = services.find(x => x.serviceCharacteristics.find(y => y.iid === c.iid))

            if (service) {
              // find the correct characteristic and update it
              const characteristic = service.serviceCharacteristics.find(x => x.iid === c.iid)
              if (characteristic) {
                characteristic.value = c.value
                service.values[characteristic.type] = c.value
                return service
              }
            }

            return undefined
          })

          // push update to listeners
          this.emit('service-update', response.filter(x => x))
        }
      } catch {
        // do nothing
      }
    }
  }

  /**
   * Bring one bridge's services into the monitor, whether it is new or known.
   *
   * The monitor used to be built once from whatever bridges had registered by
   * then, and `refreshMonitorConnection` only reconnected bridges it already
   * knew - so a bridge that registered afterwards (a slow child bridge, or one
   * held up by another Homebridge on the network at startup) had its values
   * load but never a live update, until the UI process restarted
   * (homebridge-config-ui-x#2979). The same path serves a bridge whose
   * configuration number changed: its service list is replaced and the socket
   * re-subscribed to the new characteristics.
   */
  updateInstance(refreshInstance: HapInstance, services: ServiceType[]) {
    const kept = this.services.filter(x => x.instance.username !== refreshInstance.username)
    this.services.splice(0, this.services.length, ...kept, ...services)

    const evCharacteristics = HapMonitor.evCharacteristicsOf(services)
    let instance = this.evInstances.find(x => x.username === refreshInstance.username)

    if (!evCharacteristics.length) {
      // Nothing left to watch on this bridge
      if (instance) {
        instance.socket?.destroy()
        instance.socket?.removeAllListeners()
        instance.monitoring = false
        this.evInstances.splice(this.evInstances.indexOf(instance), 1)
        this.debug(`[HapClient] [${instance.ipAddress}:${instance.port} (${instance.username})] No evented characteristics, monitor dropped`)
      }
      return
    }

    if (!instance) {
      instance = { ...refreshInstance, evCharacteristics: [] } as HapEvInstance
      this.evInstances.push(instance)
      this.debug(`[HapClient] [${instance.ipAddress}:${instance.port} (${instance.username})] Added to the monitor`)
    } else {
      instance.socket?.destroy()
      instance.socket?.removeAllListeners()
    }

    instance.name = refreshInstance.name
    instance.port = refreshInstance.port
    instance.ipAddress = refreshInstance.ipAddress
    instance.evCharacteristics = evCharacteristics
    this.connectInstance(instance)
    this.emit('monitor-refresh', instance)
  }

  /** The `ev`-capable characteristics of a set of services, as the subscribe payload wants them. */
  private static evCharacteristicsOf(services: ServiceType[]): { aid: number, iid: number, ev: boolean }[] {
    const result: { aid: number, iid: number, ev: boolean }[] = []
    for (const service of services) {
      for (const characteristic of service.serviceCharacteristics.filter(x => x.perms.includes('ev'))) {
        if (!result.some(x => x.aid === service.aid && x.iid === characteristic.iid)) {
          result.push({ aid: service.aid, iid: characteristic.iid, ev: true })
        }
      }
    }
    return result
  }

  parseServices() {
    // get a list of characteristics we can watch for each instance
    for (const service of this.services) {
      const evCharacteristics = service.serviceCharacteristics.filter(x => x.perms.includes('ev'))

      if (evCharacteristics.length) {
        // register the instance if it's not already there
        if (!this.evInstances.some(x => x.username === service.instance.username)) {
          const newInstance = { ...service.instance } as HapEvInstance
          newInstance.evCharacteristics = []
          this.evInstances.push(newInstance)
        }

        const instance = this.evInstances.find(x => x.username === service.instance.username)

        for (const evCharacteristic of evCharacteristics) {
          if (!instance.evCharacteristics.some(x => x.aid === service.aid && x.iid === evCharacteristic.iid)) {
            instance.evCharacteristics.push({ aid: service.aid, iid: evCharacteristic.iid, ev: true })
          }
        }
      }
    }
  }
}
