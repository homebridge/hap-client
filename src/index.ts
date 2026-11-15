/* global NodeJS */
import { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'
import { lookup } from 'node:dns/promises'
import { EventEmitter } from 'node:events'
import { isIPv4 } from 'node:net'

import Bonjour from 'bonjour-service'
import decamelize from 'decamelize'
import { titleize } from 'inflection'

import { Characteristics, Services } from './hap-types.js'
import { AccessoryInformation, CharacteristicType, HapAccessoriesRespType, HapCharacteristicRespType, HapClientEvents, HapClientLogger, HapInstance, ResourceRequestType, ServiceType } from './interfaces.js'
import { HapMonitor } from './monitor.js'
import { toLongFormUUID } from './uuid.js'

export * from './interfaces.js'

// The generated maps hold a name for every known UUID and a UUID for every
// known name. Looked up with a UUID from a bridge, the answer can be missing.
const serviceNames: Record<string, string | undefined> = Services
const characteristicNames: Record<string, string | undefined> = Characteristics

/** The text of something that was thrown, which need not be an Error. */
function errorMessage(e: unknown): string {
  return e instanceof Error
    ? e.message
    : String(e)
}

/** The HTTP status of a failed request, when the bridge answered with one. */
function httpStatusOf(e: unknown): number | undefined {
  return e instanceof HapHttpError
    ? e.response.status
    : undefined
}

/**
 * A read or a write which the bridge answered with a HAP error status for the
 * characteristic.
 */
export class HapCharacteristicError extends Error {
  /** The accessory id of the characteristic */
  readonly aid: number
  /** The instance id of the characteristic */
  readonly iid: number
  /** The HAP status the bridge gave, for example -70402 */
  readonly status: number | undefined

  constructor(characteristic: HapCharacteristicRespType['characteristics'][number]) {
    super(`Characteristic ${characteristic.aid}.${characteristic.iid} returned HAP status ${characteristic.status}`)
    this.name = 'HapCharacteristicError'
    this.aid = characteristic.aid
    this.iid = characteristic.iid
    this.status = characteristic.status
  }
}

/**
 * A response with an HTTP error status. fetch resolves on those where axios
 * rejected; the status is kept where an axios error had it, so the handlers
 * which name a refused pin read it the same way.
 */
class HapHttpError extends Error {
  readonly response: { status: number }

  constructor(response: { status: number, statusText: string }) {
    super(`HTTP ${response.status} ${response.statusText}`)
    this.response = { status: response.status }
  }
}

/**
 * Whether a discovered HAP device is one of Homebridge's own bridges.
 *
 * Homebridge advertises `md=homebridge` in its mDNS txt record (kept here as
 * `instance.name`); a Hue bridge says `BSB002`, a HomePod says `HomePod`, and
 * so on. Used to keep pin advice pointed only at instances the user can
 * actually fix.
 */
function isHomebridgeInstance(instance: { name?: string }): boolean {
  return instance?.name?.toLowerCase() === 'homebridge'
}

/**
 * How long a bridge gets to answer a request. Without a limit, fetch waits five
 * minutes for a bridge that accepted the connection and then went silent.
 * HAP-NodeJS itself answers a slow read after about ten seconds.
 */
const REQUEST_TIMEOUT_MS = 15000
/** A camera snapshot can take longer than a normal request. */
const RESOURCE_TIMEOUT_MS = 30000

export interface Config {
  debug?: boolean
  /** Log raw HAP TCP packets as plain text. May expose sensitive data such as the bridge PIN. */
  debugRawPackets?: boolean
  /** @deprecated Use instanceDenyList instead. This will be removed in a future release. */
  instanceBlacklist?: string[]
  instanceDenyList?: string[]
  instanceAllowList?: string[]
  discoveryTimeout?: number
  autoStartDiscovery?: boolean
}

export class HapClient extends EventEmitter<HapClientEvents> {
  private readonly bonjour = this.createBonjour()
  private browser: InstanceType<typeof Bonjour.Browser> | undefined
  private discoveryInProgress = false
  /**
   * Goes up whenever discovery is stopped, the pool is reset or the client is
   * destroyed. A found bridge is probed over HTTP, which can take seconds; a
   * probe compares the number it started with to know its result is no longer
   * wanted.
   */
  private discoveryRun = 0
  private destroyed = false

  private readonly defaultDiscoveryTimeout: number = 60000
  private readonly defaultAutoStartDiscovery: boolean = true

  private readonly logger: HapClientLogger
  private readonly pin: string
  private readonly pins: Record<string, string> = {}
  /**
   * Bridges already told off for refusing the pin, by normalised username.
   *
   * Kept on the client, not the instance: a bridge that refuses the pin is
   * never registered, so a flag on the instance object died with it and the
   * warning came back on every discovery cycle - which is exactly what the
   * owner of a second Homebridge install on the same network was seeing
   * (homebridge-config-ui-x#2979). Cleared when the bridge accepts the pin
   * again, so a mismatch that returns is reported afresh.
   */
  private readonly pinRefusals = new Set<string>()
  /** See the constructor's `ownUsernames`; undefined means every Homebridge bridge is ours. */
  private readonly ownUsernames?: Set<string>
  private readonly debugEnabled: boolean = false
  private readonly debugRawPacketsEnabled: boolean = false
  private config: Config

  private instances: HapInstance[] = []

  private hiddenServices = [Services.AccessoryInformation]
  private hiddenCharacteristics = [Characteristics.Name]

  private resetInstancePoolTimeout: NodeJS.Timeout | undefined = undefined
  private startDiscoveryTimeout: NodeJS.Timeout | undefined = undefined
  private hapMonitor: HapMonitor | undefined

  constructor(opts: {
    pin: string
    /**
     * Per-bridge pins, keyed by the bridge's username (MAC).
     *
     * ⚠️ In insecure mode a bridge still checks the `Authorization` header
     * against ITS OWN pincode, so one pin for every instance only works while
     * every child bridge inherits the main one. A child bridge with its own
     * `_bridge.pin` answers 470 and is dropped from discovery, taking its
     * accessories out of the UI (homebridge-config-ui-x#2936).
     *
     * Anything not listed here falls back to `pin`.
     */
    pins?: Record<string, string>
    /**
     * The usernames (MACs) of the bridges that belong to THIS Homebridge - the
     * main bridge and every child bridge in its config.
     *
     * Discovery probes every HAP bridge on the network, so it also finds other
     * people's Homebridge installs, and those refuse this pin forever: their pin
     * belongs to whoever runs them. When this list is given, a refusal from a
     * bridge not on it is logged at debug rather than as a warning telling the
     * owner to fix a pin that is not theirs (homebridge-config-ui-x#2979,
     * #3001). Without the list every Homebridge bridge is treated as ours.
     */
    ownUsernames?: string[]
    logger?: HapClientLogger
    config: Config
  }) {
    super()
    this.pin = opts.pin
    for (const [username, pin] of Object.entries(opts.pins ?? {})) {
      this.pins[HapClient.normaliseUsername(username)] = pin
    }
    if (opts.ownUsernames) {
      this.ownUsernames = new Set(opts.ownUsernames.map(username => HapClient.normaliseUsername(username)))
    }
    this.logger = opts.logger || console // Fallback to console if no logger is provided
    this.debugEnabled = !!opts.config.debug
    this.debugRawPacketsEnabled = !!opts.config.debugRawPackets
    this.config = {
      ...opts.config,
      discoveryTimeout: opts.config.discoveryTimeout ?? this.defaultDiscoveryTimeout,
      autoStartDiscovery: opts.config.autoStartDiscovery ?? this.defaultAutoStartDiscovery,
    }
    if (this.config.autoStartDiscovery) {
      this.startDiscovery()
    }
  }

  /**
   * bonjour-service opens the mDNS socket right away and leaves its 'error'
   * event without a listener, so a socket that can not be opened (port 5353
   * taken or not permitted) would stop the whole process. Log it instead:
   * discovery then finds nothing, but the host application keeps running.
   */
  private createBonjour(): Bonjour {
    const onError = (e: unknown) => {
      this.error(`[HapClient] Discovery :: mDNS socket error: ${e instanceof Error
        ? e.message
        : String(e)}`)
    }
    const bonjour = new Bonjour({}, onError)
    ;(bonjour as unknown as { server?: { mdns?: EventEmitter } }).server?.mdns?.on('error', onError)
    return bonjour
  }

  /**
   * Unified logging method.
   */
  private logMessage(level: 'debug' | 'info' | 'warn' | 'error', msg: string, includeStack = false) {
    const log = this.logger?.[level]
    if (typeof log !== 'function') {
      return
    }

    // Before the stack trace below: building one for every debug line is the
    // costly part, and most installs run with debug off.
    if (level === 'debug' && !this.debugEnabled) {
      return
    }

    const message = includeStack
      ? `${msg} @ ${new Error().stack?.split('\n')[3]?.trim()}` // eslint-disable-line unicorn/error-message
      : msg

    log.call(this.logger, message)
  }

  debug(msg: string) {
    this.logMessage('debug', msg, true)
  }

  private debugPacket(direction: 'received' | 'sent', instance: Pick<HapInstance, 'ipAddress' | 'port' | 'username'>, packet: Buffer) {
    if (!this.debugEnabled || !this.debugRawPacketsEnabled || typeof this.logger?.debug !== 'function') {
      return
    }

    this.logger.debug(`[HapClient] [${instance.ipAddress}:${instance.port} (${instance.username})] Raw packet ${direction}:\n${packet.toString('utf8')}`)
  }

  /**
   * Logs one request and its answer as text. fetch does not hand out the bytes
   * it sent or received, so both are written out again from what it reports:
   * the request line, the status line, the headers and the unparsed body.
   */
  private debugRawExchange(
    instance: HapInstance,
    operation: string,
    request: string,
    response: { status: number, statusText: string, headers: { entries: () => Iterable<[string, string]> } },
    body: string,
  ) {
    if (!this.debugEnabled || !this.debugRawPacketsEnabled || typeof this.logger?.debug !== 'function') {
      return
    }

    const where = `[HapClient] [${instance.ipAddress}:${instance.port} (${instance.username})]`
    const statusLine = `HTTP/1.1 ${response.status}${response.statusText
      ? ` ${response.statusText}`
      : ''}\r\n`
    const headers = [
      ...response.headers.entries(),
    ].map(([name, value]) => `${name}: ${value}\r\n`).join('')

    this.logger.debug(`${where} Raw ${operation} request sent:\n${request}`)
    this.logger.debug(`${where} Raw ${operation} response:\n${statusLine}${headers}\r\n${body}`)
  }

  info(msg: string) {
    this.logMessage('info', msg)
  }

  warn(msg: string) {
    this.logMessage('warn', msg)
  }

  error(msg: string) {
    this.logMessage('error', msg)
  }

  private async fetchJson<T>(url: string, options?: Parameters<typeof fetch>[1]): Promise<T> {
    const response = await fetch(url, {
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      ...options,
    })
    if (!response.ok) {
      throw new HapHttpError(response)
    }
    const isPut = options?.method?.toUpperCase() === 'PUT'
    if (response.status === 204 && isPut) {
      return undefined as T
    }
    const text = await response.text()
    if (!text && isPut) {
      return undefined as T
    }
    return JSON.parse(text) as T
  }

  /**
   * A bridge answers a write it refused in part or in full with 207 and a
   * status per characteristic (a plugin's set handler failed, the value is
   * read-only). A write that worked is answered with an empty 204.
   */
  private static assertWritten(resp: HapCharacteristicRespType | undefined) {
    const refused = resp?.characteristics?.find(c => c.status)
    if (refused) {
      throw new HapCharacteristicError(refused)
    }
  }

  /**
   * Forget every known bridge and search again after six seconds. For when
   * bridges restart (their ports change), for example after Homebridge itself
   * was restarted.
   */
  public resetInstancePool() {
    if (this.discoveryInProgress) {
      this.browser?.stop()
      // Mirror stopDiscovery(): detach the old browser's listeners too.
      // resetInstancePool() later creates a fresh browser via startDiscovery(),
      // so without this the stale 'up' handler leaks across reset cycles.
      this.browser?.removeAllListeners()
      this.debug(`[HapClient] Discovery :: Terminated`)
      this.discoveryInProgress = false
      this.emit('discovery-terminated')
    }
    if (this.startDiscoveryTimeout) {
      clearTimeout(this.startDiscoveryTimeout)
      this.startDiscoveryTimeout = undefined
    }
    if (this.resetInstancePoolTimeout) {
      clearTimeout(this.resetInstancePoolTimeout)
    }

    this.discoveryRun++
    this.instances = []
    this.resetInstancePoolTimeout = setTimeout(() => {
      this.refreshInstances()
    }, 6000)
  }

  /**
   * refreshInstances - Refresh the instance pool
   */
  public refreshInstances() {
    if (!this.discoveryInProgress) {
      this.startDiscovery()
    } else {
      try {
        this.debug(`[HapClient] Discovery :: Re-broadcasting discovery query`)
        this.browser?.update()
      } catch (e) {
        this.debug(`[HapClient] Discovery :: Failed to re-broadcast discovery query: ${errorMessage(e)}`)
      }
    }
  }

  public startDiscovery(discoveryTimeout?: number) {
    if (this.discoveryInProgress) {
      this.warn(`[HapClient] Discovery :: Already in progress`)
      return
    }
    this.discoveryInProgress = true

    const timeout = discoveryTimeout ?? this.config.discoveryTimeout

    const browser = this.bonjour.find({
      type: 'hap',
    })
    this.browser = browser

    // bonjour-service starts a browser as it creates it
    this.debug(`[HapClient] Discovery :: Started`)

    // stop discovery after the timeout (60 seconds unless configured)
    this.startDiscoveryTimeout = setTimeout(() => {
      browser.stop()
      this.debug(`[HapClient] Discovery :: Ended`)
      this.discoveryInProgress = false
      this.emit('discovery-ended')
    }, timeout)

    // service found, or a known service changed
    const onService = async (device: InstanceType<typeof Bonjour.Service>) => {
      if (!device || !device.txt) {
        this.debug(`[HapClient] Discovery :: Ignoring device that contains no txt records. ${JSON.stringify(device)}`)
        return
      }
      if (typeof device.txt.id !== 'string' || !device.txt.id) {
        this.debug(`[HapClient] Discovery :: Ignoring device with missing or invalid id txt record. ${JSON.stringify(device)}`)
        return
      }

      const instance: HapInstance = {
        name: device.txt.md,
        username: device.txt.id,
        ipAddress: null,
        port: device.port,
        services: [],
        connectionFailedCount: 0,
        configurationNumber: device.txt['c#'],
      }

      this.debug(`[HapClient] Discovery :: Found HAP device with username ${instance.username}`)

      // Checked after every wait below
      const run = this.discoveryRun
      const outdated = () => {
        if (run === this.discoveryRun) {
          return false
        }
        this.debug(`[HapClient] Discovery :: Dropping the probe of ${instance.username}, discovery was stopped or reset meanwhile`)
        return true
      }

      // The deny list and the old name of that option together, so an empty
      // list under one name does not hide a filled list under the other
      const denyList = [
        ...this.config.instanceDenyList ?? [],
        ...this.config.instanceBlacklist ?? [],
      ]

      // check instance is not on the denylist
      if (denyList.some(x => instance.username.toLowerCase() === x.toLowerCase())) {
        this.debug(`[HapClient] Discovery :: Instance with username ${instance.username} found in denylist. Disregarding.`)
        return
      }

      // check instance is on the allow list, when there is one
      if (this.config.instanceAllowList && this.config.instanceAllowList.length && !this.config.instanceAllowList.some(x => instance.username.toLowerCase() === x.toLowerCase())) {
        this.debug(`[HapClient] Discovery :: Instance with username ${instance.username} not found in allow list. Disregarding.`)
        return
      }

      // update an existing instance
      const existingInstanceIndex = this.instances.findIndex(x => x.username === instance.username)
      // A known bridge has moved when its address stopped working and the
      // service names other addresses. Both must hold: a bridge on two
      // networks is announced with one address per network, and a working
      // connection must not hop between them. A moved bridge is probed below
      // like a new one, and the known record only changes when the probe works.
      const moved = existingInstanceIndex > -1 && this.hasMoved(this.instances[existingInstanceIndex], device.addresses)
      if (existingInstanceIndex > -1 && !moved) {
        this.updateKnownInstance(this.instances[existingInstanceIndex], instance)
        return
      }

      // bonjour-service only collects A/AAAA records from the packet a service
      // arrived in. When several bridges share a hostname the mDNS responder
      // suppresses the repeated address records in later packets, so those
      // services reach us with no addresses at all and would be dropped without
      // ever being probed (#40). Resolving the hostname recovers them, since the
      // system resolver caches records across packets correctly.
      let addresses: string[] = Array.isArray(device.addresses)
        ? device.addresses
        : []
      if (!addresses.some(ip => isIPv4(ip)) && device.host) {
        try {
          const resolved = await lookup(device.host, { all: true, family: 4 })
          const resolvedAddresses = resolved.map(entry => entry.address)
          this.debug(`[HapClient] Discovery :: No usable address for ${instance.username}, `
            + `resolved ${device.host} to ${resolvedAddresses.join(', ') || 'nothing'}`)
          addresses = [
            ...addresses,
            ...resolvedAddresses,
          ]
        } catch (e) {
          this.debug(`[HapClient] Discovery :: Could not resolve host ${device.host} `
            + `for ${instance.username}: ${errorMessage(e)}`)
        }
        if (outdated()) {
          return
        }
      }

      for (const ip of addresses) {
        if (isIPv4(ip)) {
          try {
            this.debug(`[HapClient] Discovery :: Testing ${instance.username} via http://${ip}:${device.port}/accessories`)
            const test: HapAccessoriesRespType = await this.fetchJson(`http://${ip}:${device.port}/accessories`, {
              signal: AbortSignal.timeout(10000),
            })
            if (test.accessories) {
              this.debug(`[HapClient] Discovery :: Success ${instance.username} via http://${ip}:${device.port}/accessories`)
              instance.ipAddress = ip
              // only a usable address ends the search. A 200 with no
              // `accessories` (something else on that port, or a bridge still
              // starting) used to break out too, leaving ipAddress null and the
              // instance unregistered while a working sibling address went
              // untried - the multi-homed case #40 exists for.
              break
            }
            this.debug(`[HapClient] Discovery :: ${instance.username} answered on http://${ip}:${device.port}/accessories `
              + `without an accessories list, trying any remaining address`)
          } catch (e) {
            this.debug(`[HapClient] Discovery :: Failed ${instance.username} via http://${ip}:${device.port}/accessories`)
            this.debug(`[HapClient] Discovery :: Failed ${instance.username} with error: ${errorMessage(e)}`)
          }
          if (outdated()) {
            return
          }
        }
      }

      // store instance record if the connection works
      const connected = !!instance.ipAddress && await this.checkInstanceConnection(instance)
      if (outdated()) {
        return
      }
      const known = this.instances.find(x => x.username === instance.username)
      if (connected && known && moved && known.ipAddress !== instance.ipAddress) {
        this.debug(`[HapClient] Discovery :: [${instance.ipAddress}:${instance.port} (${instance.username})] Instance moved from ${known.ipAddress}`)
        known.ipAddress = instance.ipAddress
        known.port = instance.port
        known.name = instance.name
        known.configurationNumber = instance.configurationNumber
        known.connectionFailedCount = 0
        this.emit('instance-discovered', known)
        // The monitor still holds the old address
        void this.syncMonitorInstance(known)
        return
      }
      if (connected && known) {
        // A second probe of the same bridge got there first
        this.debug(`[HapClient] Discovery :: [${instance.ipAddress}:${instance.port} (${instance.username})] Instance already registered`)
        return
      }
      if (connected) {
        this.instances.push(instance)
        this.debug(`[HapClient] Discovery :: [${instance.ipAddress}:${instance.port} (${instance.username})] Instance Registered`)
        this.emit('instance-discovered', instance)
        // A bridge that registers after the monitor was built has to be added
        // to it, or it never gets live updates (homebridge-config-ui-x#2979)
        void this.syncMonitorInstance(instance)
      } else if (known && moved) {
        // The new address did not answer: treat the announcement as before
        this.updateKnownInstance(known, instance)
      } else {
        this.debug(`[HapClient] Discovery :: Could not register to device with username ${instance.username}`)
      }
    }
    browser.on('up', onService)
    // bonjour-service emits 'up' only for a service it has not seen before. A
    // change to one it knows comes as 'txt-update' (the configuration number
    // went up, so the accessories changed) or 'srv-update' (a new port).
    browser.on('txt-update', onService)
    browser.on('srv-update', onService)
  }

  /** Take over what a new announcement says about a bridge already in the pool, and reconnect the monitor when needed. */
  private updateKnownInstance(known: HapInstance, instance: HapInstance) {
    const configurationChanged = known.configurationNumber !== instance.configurationNumber
    if (
      known.port !== instance.port
      || known.name !== instance.name
      || configurationChanged
    ) {
      known.port = instance.port
      known.name = instance.name
      known.configurationNumber = instance.configurationNumber
      this.debug(`[HapClient] Discovery :: [${known.ipAddress}:${instance.port} `
        + `(${instance.username})] Instance Updated`)
      this.emit('instance-discovered', known)
      if (configurationChanged) {
        this.emit('instance-configuration-changed', known)
        // The accessories changed, so the monitor needs the new service
        // list, not just a fresh socket to the old one
        void this.syncMonitorInstance(known)
      } else {
        this.hapMonitor?.refreshMonitorConnection(known)
      }
    } else if (this.hapMonitor && this.hapMonitor.isInstanceMonitored(instance.username) && !this.hapMonitor.isInstanceConnected(instance.username)) {
      // Same port/name/config but the socket is dead (e.g. same-port restart) - reconnect immediately
      this.debug(`[HapClient] Discovery :: [${known.ipAddress}:${instance.port} `
        + `(${instance.username})] Instance re-announced with closed socket, reconnecting`)
      this.hapMonitor.refreshMonitorConnection(known)
    }
  }

  /**
   * Whether a known bridge is now at another address: the service names IPv4
   * addresses, the known one is not among them, and the known one fails (a
   * read failed, or the monitor has lost its connection).
   */
  private hasMoved(known: HapInstance, addresses: unknown): boolean {
    const announced = Array.isArray(addresses)
      ? addresses.filter(ip => typeof ip === 'string' && isIPv4(ip))
      : []
    if (!announced.length || !known.ipAddress || announced.includes(known.ipAddress)) {
      return false
    }
    return known.connectionFailedCount > 0
      || (!!this.hapMonitor?.isInstanceMonitored(known.username) && !this.hapMonitor.isInstanceConnected(known.username))
  }

  public stopDiscovery() {
    this.discoveryRun++
    this.discoveryInProgress = false
    this.browser?.stop()
    this.browser?.removeAllListeners()
    if (this.startDiscoveryTimeout) {
      clearTimeout(this.startDiscoveryTimeout)
      this.startDiscoveryTimeout = undefined
    }
    this.debug(`[HapClient] Discovery :: Stopped`)
    this.emit('discovery-stopped')
  }

  /** Usernames are MACs; compare them without caring about case. */
  private static normaliseUsername(username: string): string {
    return username.toUpperCase()
  }

  /**
   * The pin to authenticate with for a given bridge - its own if one was
   * supplied, otherwise the main bridge's.
   */
  private pinFor(instance: { username?: string }): string {
    return (instance?.username && this.pins[HapClient.normaliseUsername(instance.username)]) || this.pin
  }

  /**
   * Checks that the bridge accepts the pin, with a write to a characteristic
   * that does not exist: a bridge checks the pin before it looks at the write.
   */
  private async checkInstanceConnection(instance: HapInstance): Promise<boolean> {
    try {
      await this.fetchJson(`http://${instance.ipAddress}:${instance.port}/characteristics`, {
        method: 'PUT',
        headers: {
          'Authorization': this.pinFor(instance),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          characteristics: [
            { aid: -1, iid: -1 },
          ],
        }),
      })
      // A working connection clears the pin complaint, so a mismatch that comes
      // back later is reported again rather than staying silent.
      this.pinRefusals.delete(HapClient.normaliseUsername(instance.username))
      return true
    } catch (e) {
      this.debug(`[HapClient] Discovery :: [${instance.ipAddress}:${instance.port} (${instance.username})] returned an error while attempting connection: ${errorMessage(e)}`)
      // A 470 here is a pin mismatch, not an unreachable bridge - the same
      // cause the control paths below already name. Saying so is what stops it
      // reading as a discovery or network fault: the bridge answered, it just
      // refused this pin.
      //
      // ⚠️ Only for Homebridge's own bridges. Discovery browses `_hap._tcp`, so
      // it probes EVERY HomeKit accessory on the network - a Hue bridge, a
      // HomePod, another HAP server such as Scrypted sharing the host. Those
      // refuse the pin because they are paired to Apple Home and are nothing to
      // do with Homebridge, so telling their owner to "set the Homebridge pin"
      // is advice they cannot act on. The mDNS `md` record, kept as
      // `instance.name`, is what separates the two.
      // Once per bridge, not once per discovery cycle. The cause does not
      // change between probes, and a second Homebridge install on the same
      // network refuses this pin forever - its pin belongs to whoever runs it,
      // not to the user reading this log (#2979). Remembered on the client, see
      // pinRefusals: the instance object is discarded when registration fails.
      const refusalKey = HapClient.normaliseUsername(instance.username)
      const status = httpStatusOf(e)
      if ((status === 470 || status === 401) && isHomebridgeInstance(instance) && !this.pinRefusals.has(refusalKey)) {
        this.pinRefusals.add(refusalKey)
        // Only a bridge of ours can have its pin corrected by whoever reads
        // this log. Another Homebridge on the network is expected to refuse.
        if (this.ownUsernames === undefined || this.ownUsernames.has(refusalKey)) {
          this.warn(`[HapClient] Discovery :: [${instance.ipAddress}:${instance.port} (${instance.username})] `
            + `refused the pin, so its accessories will not be shown. Make sure the Homebridge pin for this instance is set to ${this.pinFor(instance)}.`)
        } else {
          this.debug(`[HapClient] Discovery :: [${instance.ipAddress}:${instance.port} (${instance.username})] `
            + `refused the pin and is not one of this Homebridge's bridges, so it is another Homebridge on the network - its accessories are not shown here and nothing needs changing.`)
        }
      }
      return false
    }
  }

  /**
   * Give a running monitor this bridge's current services - see
   * HapMonitor.updateInstance. Only this bridge is fetched, so registering one
   * more bridge does not re-read every other one. A failure is logged and left
   * for the next discovery cycle; it must never break discovery itself.
   */
  private async syncMonitorInstance(instance: HapInstance): Promise<void> {
    if (!this.hapMonitor) {
      return
    }
    try {
      const services = await this.getAllServices(instance)
      if (this.destroyed) {
        return
      }
      // getAccessories() swallows a failed read and returns nothing, which
      // updateInstance() would take as "no services" and drop the bridge. A
      // bridge whose configuration just changed has usually just restarted, so
      // a failed read is likely here: reconnect the existing subscriptions
      // instead, as before this sync existed, and leave the rest to the next
      // configuration change.
      if (instance.connectionFailedCount > 0) {
        this.hapMonitor.refreshMonitorConnection(instance)
        return
      }
      this.hapMonitor.updateInstance(instance, services.filter(x => x.instance.username === instance.username))
    } catch (e) {
      this.debug(`[HapClient] [${instance.ipAddress}:${instance.port} (${instance.username})] Could not add the bridge to the monitor: ${errorMessage(e)}`)
    }
  }

  private async getAccessories(only?: HapInstance): Promise<HapAccessoriesRespType['accessories']> {
    if (!this.instances.length) {
      this.debug('[HapClient] Cannot load accessories. No Homebridge instances have been discovered.')
    }

    // A snapshot of the pool: the catch below can remove a failing instance
    // from this.instances while the other requests are still under way. All
    // bridges are asked at the same time, and Promise.all keeps their order.
    const targets = only
      ? [only]
      : [...this.instances]
    const perInstance = await Promise.all(targets.map(async (instance) => {
      try {
        const resp: HapAccessoriesRespType = await this.fetchJson(`http://${instance.ipAddress}:${instance.port}/accessories`)
        instance.connectionFailedCount = 0
        for (const accessory of resp.accessories) {
          accessory.instance = instance
        }
        return resp.accessories
      } catch {
        instance.connectionFailedCount++
        this.debug(`[HapClient] [${instance.ipAddress}:${instance.port} (${instance.username})] Failed to connect`)

        if (instance.connectionFailedCount > 5) {
          const instanceIndex = this.instances.findIndex(x => x.username === instance.username && x.ipAddress === instance.ipAddress)
          if (instanceIndex > -1) {
            this.instances.splice(instanceIndex, 1)
            this.debug(`[HapClient] [${instance.ipAddress}:${instance.port} (${instance.username})] Removed From Instance Pool`)
          }
        }
        return []
      }
    }))
    return perInstance.flat()
  }

  /**
   * monitorCharacteristics
   * @param services - Optional array of services to monitor
   *
   * Creates connections to all Homebridge instances and monitors all characteristics for changes.  Will emit `service-update` events when characteristics change, which can be listened to.
   * @returns HapMonitor instance which is an EventEmitter that emits `service-update` events when characteristics change. The event callback receives the updated service as a parameter.
   */
  public async monitorCharacteristics(services?: ServiceType[]) {
    // If `services` is not provided, retrieve all services
    services = services ?? await this.getAllServices()
    this.hapMonitor?.finish()
    this.hapMonitor = new HapMonitor(
      this.logger,
      this.debug.bind(this),
      instance => this.pinFor(instance),
      services,
      this.debugPacket.bind(this),
    )
    return this.hapMonitor
  }

  /**
   *
   * @returns Array of all services from all Homebridge instances
   */
  public async getAllServices(only?: HapInstance) {
    /* Get Accessories from HAP */
    const accessories = await this.getAccessories(only)

    const services: Array<ServiceType> = []

    /* Parse All Accessories */
    accessories.forEach((accessory) => {
      /** Ensure UUIDs are long form */
      for (const service of accessory.services) {
        service.type = toLongFormUUID(service.type)
        for (const characteristic of service.characteristics) {
          characteristic.type = toLongFormUUID(characteristic.type)
        }
      }

      /* Parse Accessory Information */
      const accessoryInformationService = accessory.services.find(x => x.type === Services.AccessoryInformation)
      const accessoryInformation: AccessoryInformation = {}

      if (accessoryInformationService && accessoryInformationService.characteristics) {
        accessoryInformationService.characteristics.forEach((c) => {
          if (c.value) {
            accessoryInformation[c.description] = c.value
          }
        })
      }

      /* Parse All Services */
      accessory.services
        .forEach((s) => {
          /* Only services with a known type are surfaced */
          const serviceType = serviceNames[s.type]
          if (!serviceType || this.hiddenServices.includes(s.type)) {
            return
          }

          /* The name characteristic, or a default if none is defined or its value is null/undefined */
          const serviceName = String(s.characteristics.find(x => x.type === Characteristics.Name)?.value
            ?? (accessoryInformation.Name || this.humanizeString(serviceType)))

          /* Parse Service Characteristics */
          const serviceCharacteristics: Array<CharacteristicType> = s.characteristics
            .flatMap((c) => {
              /* Only characteristics with a known type are surfaced */
              const characteristicType = characteristicNames[c.type]
              if (!characteristicType || this.hiddenCharacteristics.includes(c.type)) {
                return []
              }
              return {
                aid: accessory.aid,
                iid: c.iid,
                uuid: c.type,
                type: characteristicType,
                serviceType,
                serviceName,
                description: c.description,
                value: c.value,
                format: c.format,
                perms: c.perms,
                unit: c.unit,
                maxValue: c.maxValue,
                minValue: c.minValue,
                minStep: c.minStep,
                validValues: c['valid-values'],
                canRead: c.perms.includes('pr'),
                canWrite: c.perms.includes('pw'),
                ev: c.perms.includes('ev'),
              }
            })

          const service: ServiceType = {
            aid: accessory.aid,
            iid: s.iid,
            uuid: s.type,
            type: serviceType,
            humanType: this.humanizeString(serviceType),
            serviceName: serviceName.length
              ? serviceName
              : String(accessoryInformation.Name ?? ''),
            serviceCharacteristics,
            accessoryInformation,
            values: {},
            linked: s.linked,
            instance: accessory.instance,
          }

          // generate unique id for service. The parts are separated, so that
          // accessory 1 service 18 and accessory 11 service 8 differ.
          service.uniqueId = createHash('sha256')
            .update([
              service.instance.username,
              service.aid,
              service.iid,
              service.type,
            ].join('|'))
            .digest('hex')

          // the unique id as it was built up to v5.4.0, without separators (so
          // two services could share one). Only for moving data that was saved
          // under the old id over to the new one.
          service.legacyUniqueId = createHash('sha256')
            .update(`${service.instance.username}${service.aid}${service.iid}${service.type}`)
            .digest('hex')

          // generate a stable name-based unique id that remains consistent even if the accessory aid changes
          service.nameBasedUniqueId = createHash('sha256')
            .update([
              service.instance.name,
              service.instance.username,
              service.accessoryInformation.Manufacturer,
              service.serviceName,
              service.uuid.slice(0, 8),
            ].join('|'))
            .digest('hex')

          /* Helper function to trigger a call to the accessory to get all the characteristic values */
          service.refreshCharacteristics = () => {
            return this.refreshServiceCharacteristics(service)
          }

          /* Helper function to set the value of a characteristic */
          service.setCharacteristic = (iid: number, value: number | string | boolean) => {
            return this.setCharacteristic(service, iid, value)
          }

          service.setCharacteristicByType = (type: string, value: number | string | boolean) => {
            return this.setCharacteristicByType(service, type, value)
          }

          service.setCharacteristicsByTypes = (payload: Record<string, string | number | boolean>) => {
            return this.setCharacteristicsByTypes(service, payload)
          }

          /* Helper function to return a characteristic by its type name */
          service.getCharacteristic = (type: string) => {
            return service.serviceCharacteristics.find(c => c.type === type)
          }

          if (service.type === 'CameraRTPStreamManagement') {
            service.getResource = (body: ResourceRequestType) => {
              return this.getResource(service, body)
            }
          }
          service.serviceCharacteristics.forEach((c) => {
            /* Helper function to set the value of a characteristic */
            c.setValue = async (value: number | string | boolean) => {
              return await this.setCharacteristic(service, c.iid, value)
            }

            /* Helper function to get the value of a characteristic from the accessory */
            c.getValue = async () => {
              return await this.getCharacteristic(service, c.iid)
            }

            /* set the values for each characteristic type in an easy-to-access object */
            service.values[c.type] = c.value
          })

          services.push(service)
        })
    })

    return services
  }

  /**
   * The first service with this iid.
   *
   * ⚠️ An iid is only unique inside one accessory (the first service of every
   * accessory usually has the same one), so with more than one accessory this
   * can return a service of another accessory. Filter `getAllServices()` by
   * `uniqueId` instead.
   */
  async getService(iid: number) {
    const services = await this.getAllServices()
    return services.find(x => x.iid === iid)
  }

  /** The first service with this name. Names are not unique: two accessories can share one. */
  async getServiceByName(serviceName: string) {
    const services = await this.getAllServices()
    return services.find(x => x.serviceName === serviceName)
  }

  /** Resolves with nothing when the bridge could not be reached (the error is logged). */
  async refreshServiceCharacteristics(service: ServiceType): Promise<ServiceType | undefined> {
    try {
      const iids: number[] = service.serviceCharacteristics.filter(c => c.canRead).map(c => c.iid)
      if (!iids.length) {
        return service
      }

      const url = `http://${service.instance.ipAddress}:${service.instance.port}/characteristics?id=${encodeURIComponent(iids.map(iid => `${service.aid}.${iid}`).join(','))}`
      const resp: HapCharacteristicRespType = await this.fetchJson(url)

      let firstError: HapCharacteristicError | undefined
      resp.characteristics.forEach((c) => {
        const characteristic = service.serviceCharacteristics.find(x => x.iid === c.iid && x.aid === c.aid)
        if (!characteristic) {
          return
        }
        characteristic.status = c.status ?? 0
        if (characteristic.status !== 0) {
          firstError ??= new HapCharacteristicError(c)
          return
        }
        if (c.value !== undefined) {
          characteristic.value = c.value
          service.values[characteristic.type] = c.value
        }
      })
      if (firstError) {
        throw firstError
      }
      return service
    } catch (e) {
      if (e instanceof HapCharacteristicError) {
        throw e
      }
      this.debug(`[HapClient] +${e}`)
      this.error(`[HapClient] Failed to refresh characteristics for ${service.serviceName}: ${errorMessage(e)}`)
      return undefined
    }
  }

  /** Resolves with nothing when the bridge could not be reached (the error is logged), or did not answer for this characteristic. */
  async getCharacteristic(service: ServiceType, iid: number): Promise<CharacteristicType | undefined> {
    try {
      const characteristicId = `${service.aid}.${iid}`
      const requestTarget = `/characteristics?id=${encodeURIComponent(characteristicId)}`
      const response = await fetch(`http://${service.instance.ipAddress}:${service.instance.port}${requestTarget}`, {
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      })
      if (!response.ok) {
        throw new HapHttpError(response)
      }
      const responseData = await response.text()
      this.debugRawExchange(
        service.instance,
        `getValue(${characteristicId})`,
        `GET ${requestTarget} HTTP/1.1\r\nHost: ${service.instance.ipAddress}:${service.instance.port}\r\n\r\n`,
        response,
        responseData,
      )
      const resp: HapCharacteristicRespType = JSON.parse(responseData)

      const respCharacteristic = resp.characteristics?.[0]
      if (!respCharacteristic) {
        return undefined
      }
      const characteristic = service.serviceCharacteristics.find(x => x.iid === respCharacteristic.iid && x.aid === respCharacteristic.aid)
      if (!characteristic) {
        return undefined
      }
      characteristic.status = respCharacteristic.status ?? 0
      if (characteristic.status !== 0) {
        throw new HapCharacteristicError(respCharacteristic)
      }
      if (respCharacteristic.value !== undefined) {
        characteristic.value = respCharacteristic.value
        service.values[characteristic.type] = respCharacteristic.value
      }

      return characteristic
    } catch (e) {
      if (e instanceof HapCharacteristicError) {
        throw e
      }
      this.debug(`[HapClient] +${e}`)
      this.error(`[HapClient] Failed to get characteristic for ${service.serviceName} with iid ${iid}: ${errorMessage(e)}`)
      return undefined
    }
  }

  async setCharacteristicByType(service: ServiceType, type: string, value: number | string | boolean) {
    const characteristic = service.serviceCharacteristics.find(x => x.type === type)
    if (!characteristic) {
      throw new Error(`Characteristic ${type} not found in service ${service.serviceName}`)
    }
    return this.setCharacteristic(service, characteristic.iid, value)
  }

  async setCharacteristic(service: ServiceType, iid: number, value: number | string | boolean) {
    try {
      HapClient.assertWritten(await this.fetchJson<HapCharacteristicRespType | undefined>(`http://${service.instance.ipAddress}:${service.instance.port}/characteristics`, {
        method: 'PUT',
        headers: {
          'Authorization': this.pinFor(service.instance),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          characteristics: [
            {
              aid: service.aid,
              iid,
              value,
            },
          ],
        }),
      }))
      // A write-only characteristic (a remote key, identify) answers a read
      // with an error status, which would report a write that worked as failed.
      const written = service.serviceCharacteristics.find(x => x.iid === iid)
      if (written && !written.canRead) {
        return written
      }
      return this.getCharacteristic(service, iid)
    } catch (e) {
      throw this.requestFailure(service, e, `Failed to set value for ${service.serviceName}.`, 'Failed to control accessory', 'Failed to control accessory')
    }
  }

  async setCharacteristicsByTypes(service: ServiceType, payload: Record<string, string | number | boolean>) {
    const characteristics = Object.entries(payload).map(([type, value]) => {
      const characteristic = service.serviceCharacteristics.find(x => x.type === type)
      if (!characteristic) {
        throw new Error(`Characteristic ${type} not found in service ${service.serviceName}`)
      }
      if (type === 'ConfiguredName') {
        // A write of several values never renames the service. The check used
        // to compare with 'Configured Name', which no type is called, so it
        // never matched.
        return null
      }
      return {
        aid: service.aid,
        iid: characteristic.iid,
        value,
      }
    }).filter(item => item !== null)
    if (!characteristics.length) {
      return service
    }
    return this.setCharacteristics(service, characteristics)
  }

  async setCharacteristics(service: ServiceType, characteristics: { aid: number, iid: number, value: string | number | boolean }[]) {
    try {
      HapClient.assertWritten(await this.fetchJson<HapCharacteristicRespType | undefined>(`http://${service.instance.ipAddress}:${service.instance.port}/characteristics`, {
        method: 'PUT',
        headers: {
          'Authorization': this.pinFor(service.instance),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          characteristics,
        }),
      }))
      return this.refreshServiceCharacteristics(service)
    } catch (e) {
      throw this.requestFailure(service, e, `Failed to set value for ${service.serviceName}.`, 'Failed to control accessory', 'Failed to control accessory')
    }
  }

  /** Resolves with the image, or with nothing when the bridge answered without one. */
  async getResource(service: ServiceType, body: ResourceRequestType): Promise<Buffer | undefined> {
    try {
      const response = await fetch(`http://${service.instance.ipAddress}:${service.instance.port}/resource`, {
        method: 'POST',
        headers: {
          'Authorization': this.pinFor(service.instance),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          ...body,
          aid: service.aid,
        }),
        signal: AbortSignal.timeout(RESOURCE_TIMEOUT_MS),
      })
      // Reject, so the catch below can name a refused pin
      if (!response.ok) {
        throw new HapHttpError(response)
      }
      if (response.status === 200) {
        return Buffer.from(await response.arrayBuffer())
      }
      this.warn(`[HapClient] getResource [${service.instance.ipAddress}:${service.instance.port} (${service.instance.username})] `
        + `Failed to request resource from accessory ${service.serviceName}. Response status Code ${response.status}`)
      return undefined
    } catch (e) {
      throw this.requestFailure(service, e, `Failed to request resource from accessory ${service.serviceName}.`, 'Failed to request resource from accessory', 'Failed to request resource')
    }
  }

  /**
   * Logs a write or resource request which failed, and returns the error to
   * reject with. A bridge that refused the pin answers 470 (or 401): the log
   * and the error then name the pin, since that is what has to be corrected.
   */
  private requestFailure(service: ServiceType, e: unknown, logLine: string, pinFailure: string, otherFailure: string): Error {
    const where = `[HapClient] [${service.instance.ipAddress}:${service.instance.port} (${service.instance.username})]`
    this.error(`${where} ${logLine}`)
    if (e instanceof HapCharacteristicError) {
      this.error(`[HapClient] ${e.message}`)
      return e
    }
    const status = httpStatusOf(e)
    if (status === 470 || status === 401) {
      this.warn(`${where} Make sure Homebridge pin for this instance is set to ${this.pinFor(service.instance)}.`)
      return new Error(`${pinFailure}. Make sure the Homebridge pin for ${service.instance.ipAddress}:${service.instance.port} `
        + `is set to ${this.pinFor(service.instance)}.`)
    }
    this.error(errorMessage(e))
    return new Error(`${otherFailure}: ${errorMessage(e)}`)
  }

  private humanizeString(string: string) {
    return titleize(decamelize(string))
  }

  /**
   * Stops discovery and the monitor, and closes the mDNS socket. The client
   * can not be used again afterwards.
   */
  public destroy() {
    this.destroyed = true
    this.discoveryRun++
    this.browser?.stop()
    this.hapMonitor?.finish()
    this.discoveryInProgress = false
    if (this.resetInstancePoolTimeout) {
      clearTimeout(this.resetInstancePoolTimeout)
    }
    if (this.startDiscoveryTimeout) {
      clearTimeout(this.startDiscoveryTimeout)
    }
    this.bonjour.destroy()
  }
}
