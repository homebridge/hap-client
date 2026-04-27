import { EventEmitter } from 'node:events'

import { createConnection, parseMessage } from './eventedHttpClient/index.js'
import { HapEvInstance, ServiceType } from './interfaces.js'

/**
 * HapMonitor - Creates a monitor to watch for changes in accessory characteristics.  And generates 'service-update' events when they change.
 */
export class HapMonitor extends EventEmitter {
  private readonly pin
  private readonly evInstances: HapEvInstance[]
  private readonly services: ServiceType[]
  private logger: any
  private readonly debug: (arg0: string) => void
  private _stopped = false
  private readonly _reconnectDelays = new Map<string, number>()
  private readonly _reconnectTimers = new Map<string, ReturnType<typeof setTimeout>>()

  constructor(logger: any, debug: any, pin: string, services: ServiceType[]) {
    super()
    this.logger = logger
    this.debug = debug
    this.pin = pin
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
    this.logger?.log(`[HapMonitor] ERROR: ${message}`)
  }

  start() {
    for (const instance of this.evInstances) {
      this.connectInstance(instance)
    }
  }

  connectInstance(instance: HapEvInstance) {
    try {
      this.debug(`[HapClient] [${instance.ipAddress}:${instance.port} (${instance.username})] Connecting`)
      instance.socket = createConnection(instance, this.pin, { characteristics: instance.evCharacteristics })
      instance.monitoring = true

      this.debug(`[HapClient] [${instance.ipAddress}:${instance.port} (${instance.username})] Connected`)

      instance.socket.on('data', (data) => {
        const message = parseMessage(data)

        if (message.statusCode === 401) {
          this.debug(`[HapClient] [${instance.ipAddress}:${instance.port} (${instance.username})] `
            + `${message.statusCode} ${message.statusMessage} - make sure Homebridge pin for this instance is set to ${this.pin}.`)
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
    this._stopped = true
    for (const timer of this._reconnectTimers.values()) {
      clearTimeout(timer)
    }
    this._reconnectTimers.clear()
    this._reconnectDelays.clear()
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
      instance.socket.destroy()
      instance.socket.removeAllListeners()
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
    return instance?.monitoring
  }

  /**
   * Returns true if the monitor has an active (non-destroyed) socket for the
   * given instance username, false otherwise.
   */
  isInstanceConnected(username: string): boolean {
    const instance = this.evInstances.find(x => x.username === username)
    return instance?.socket != null && instance?.socket !== undefined && !instance.socket.destroyed
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
