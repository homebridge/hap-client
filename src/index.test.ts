import { Buffer } from 'node:buffer'
import { lookup } from 'node:dns/promises'
import { EventEmitter } from 'node:events'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { Characteristics, Services } from './hap-types.js'
import { HapCharacteristicError, HapClient } from './index.js'

const mockFetch = vi.fn()

function fetchResponse(
  data: unknown,
  status = 200,
  statusText = 'OK',
  headers: Record<string, string> = {},
) {
  const body = typeof data === 'string'
    ? data
    : JSON.stringify(data)

  return {
    ok: status >= 200 && status < 300,
    status,
    statusText,
    headers: {
      entries: () => Object.entries(headers),
    },
    json: async () => JSON.parse(body),
    text: async () => body,
    arrayBuffer: async () => Uint8Array.from(Buffer.from(body)).buffer,
  }
}

vi.stubGlobal('fetch', mockFetch)

beforeEach(() => {
  mockFetch.mockReset()
})

vi.mock('node:dns/promises', () => ({
  lookup: vi.fn(),
}))

let mockBrowserOn: ReturnType<typeof vi.fn>
let mockBrowserRemoveAllListeners: ReturnType<typeof vi.fn>
let mockBrowserUpdate: ReturnType<typeof vi.fn>

vi.mock('bonjour-service', () => ({
  default: class MockBonjour {
    stop = vi.fn()
    destroy = vi.fn()
    find = vi.fn().mockImplementation(() => {
      mockBrowserOn = vi.fn()
      mockBrowserRemoveAllListeners = vi.fn()
      mockBrowserUpdate = vi.fn()
      return {
        start: vi.fn(),
        stop: vi.fn(),
        on: mockBrowserOn,
        removeAllListeners: mockBrowserRemoveAllListeners,
        update: mockBrowserUpdate,
      }
    })
  },
}))

describe('hapClient', () => {
  let hapClient: HapClient

  beforeEach(() => {
    hapClient = new HapClient({ pin: '123-45-678', config: {} })
  })

  it('should initialize correctly', () => {
    expect(hapClient).toBeInstanceOf(EventEmitter)
  })

  afterEach(() => {
    hapClient.destroy()
  })
})

describe('hapClient raw packet logging', () => {
  const instance = {
    name: 'Test Bridge',
    username: 'AA:BB:CC:DD:EE:FF',
    ipAddress: '127.0.0.1',
    port: 51826,
    services: [],
    connectionFailedCount: 0,
    configurationNumber: 1,
  }

  it('passes the raw packet to the debug logger as plain text when enabled', () => {
    const debug = vi.fn()
    const client = new HapClient({
      pin: '123-45-678',
      logger: { debug },
      config: { autoStartDiscovery: false, debug: true, debugRawPackets: true },
    })
    const packet = Buffer.from('EVENT/1.0 200 OK\r\nContent-Length: 0\r\n\r\n')

      ; (client as any).debugPacket('received', instance, packet)

    expect(debug).toHaveBeenCalledWith(
      '[HapClient] [127.0.0.1:51826 (AA:BB:CC:DD:EE:FF)] Raw packet received:\n'
      + 'EVENT/1.0 200 OK\r\nContent-Length: 0\r\n\r\n',
    )
    client.destroy()
  })

  it('does not log raw packets unless both debug options are enabled', () => {
    const debug = vi.fn()
    const client = new HapClient({
      pin: '123-45-678',
      logger: { debug },
      config: { autoStartDiscovery: false, debug: true },
    })

      ; (client as any).debugPacket('received', instance, Buffer.from('packet'))

    expect(debug).not.toHaveBeenCalled()
    client.destroy()
  })
})

describe('hapClient bonjour up handler - same-port restart', () => {
  let hapClient: HapClient
  let upHandler: (device: any) => Promise<void>

  beforeEach(() => {
    hapClient = new HapClient({
      pin: '123-45-678',
      config: { autoStartDiscovery: false },
    })
    hapClient.startDiscovery()

    // Extract the 'up' handler registered on the browser
    const upCall = mockBrowserOn.mock.calls.find(([event]) => event === 'up')
    upHandler = upCall?.[1]
  })

  afterEach(() => {
    hapClient.destroy()
  })

  it('should call refreshMonitorConnection when the socket is closed for a same-port re-announced instance', async () => {
    const username = 'AA:BB:CC:DD:EE:FF'

    // Inject a pre-existing instance into the client
    const existingInstance = {
      name: 'Test Bridge',
      username,
      ipAddress: '127.0.0.1',
      port: 51826,
      services: [],
      connectionFailedCount: 0,
      configurationNumber: 1,
    };
    (hapClient as any).instances = [existingInstance]

    // Attach a mock hapMonitor with the socket marked as closed
    const refreshMonitorConnectionSpy = vi.fn()
      ; (hapClient as any).hapMonitor = {
      isInstanceConnected: vi.fn().mockReturnValue(false),
      isInstanceMonitored: vi.fn().mockReturnValue(true),
      refreshMonitorConnection: refreshMonitorConnectionSpy,
      finish: vi.fn(),
    }

    // Simulate bonjour re-announcing the same device (same port/name/configurationNumber)
    await upHandler({
      txt: { 'c#': 1, 'id': username, 'md': 'Test Bridge' },
      port: 51826,
      addresses: [],
    })

    expect(refreshMonitorConnectionSpy).toHaveBeenCalledWith(existingInstance)
  })

  // A bridge that registers after the monitor was built has to be added to it,
  // with its own services only - or it never gets live updates (#2979)
  it('adds a newly registered bridge to a running monitor, with only that bridge\'s services', async () => {
    const username = '11:22:33:44:55:66'
    const updateInstance = vi.fn()
    ;(hapClient as any).hapMonitor = {
      updateInstance,
      refreshMonitorConnection: vi.fn(),
      isInstanceConnected: vi.fn(),
      isInstanceMonitored: vi.fn(),
      finish: vi.fn(),
    }
    const ours = {
      instance: { username },
      aid: 1,
    }
    const theirs = {
      instance: { username: 'AA:BB:CC:DD:EE:FF' },
      aid: 1,
    }
    ;(hapClient as any).getAllServices = vi.fn().mockResolvedValue([ours, theirs])
    mockFetch.mockResolvedValueOnce(fetchResponse({ accessories: [] }))
    mockFetch.mockResolvedValueOnce(fetchResponse({}))

    await upHandler({
      txt: { 'c#': 1, 'id': username, 'md': 'homebridge' },
      port: 51826,
      addresses: ['127.0.0.1'],
    })

    await vi.waitFor(() => expect(updateInstance).toHaveBeenCalledTimes(1))
    const [instance, services] = updateInstance.mock.calls[0]
    expect(instance.username).toBe(username)
    expect(services).toEqual([ours])
  })

  it('refreshes a bridge\'s services in the monitor when its configuration number changes', async () => {
    const username = 'AA:BB:CC:DD:EE:FF'
    ;(hapClient as any).instances = [
      {
        name: 'Test Bridge',
        username,
        ipAddress: '127.0.0.1',
        port: 51826,
        services: [],
        connectionFailedCount: 0,
        configurationNumber: 1,
      },
    ]
    const updateInstance = vi.fn()
    const refreshMonitorConnection = vi.fn()
    ;(hapClient as any).hapMonitor = {
      updateInstance,
      refreshMonitorConnection,
      isInstanceConnected: vi.fn().mockReturnValue(true),
      isInstanceMonitored: vi.fn().mockReturnValue(true),
      finish: vi.fn(),
    }
    ;(hapClient as any).getAllServices = vi.fn().mockResolvedValue([
      {
        instance: { username },
        aid: 1,
      },
    ])

    await upHandler({
      txt: { 'c#': 2, 'id': username, 'md': 'Test Bridge' },
      port: 51826,
      addresses: [],
    })

    await vi.waitFor(() => expect(updateInstance).toHaveBeenCalledTimes(1))
    expect(refreshMonitorConnection).not.toHaveBeenCalled()
  })

  // A bridge whose configuration changed has usually just restarted, so the
  // read can fail. That must not be taken as "no services" and drop the bridge.
  it('reconnects the existing subscriptions when the read after a configuration change fails', async () => {
    const username = 'AA:BB:CC:DD:EE:FF'
    const existingInstance = {
      name: 'Test Bridge',
      username,
      ipAddress: '127.0.0.1',
      port: 51826,
      services: [],
      connectionFailedCount: 0,
      configurationNumber: 1,
    }
    ;(hapClient as any).instances = [existingInstance]
    const updateInstance = vi.fn()
    const refreshMonitorConnection = vi.fn()
    ;(hapClient as any).hapMonitor = {
      updateInstance,
      refreshMonitorConnection,
      isInstanceConnected: vi.fn().mockReturnValue(true),
      isInstanceMonitored: vi.fn().mockReturnValue(true),
      finish: vi.fn(),
    }
    mockFetch.mockRejectedValueOnce(new TypeError('fetch failed'))

    await upHandler({
      txt: { 'c#': 2, 'id': username, 'md': 'Test Bridge' },
      port: 51826,
      addresses: [],
    })

    await vi.waitFor(() => expect(refreshMonitorConnection).toHaveBeenCalledWith(existingInstance))
    expect(updateInstance).not.toHaveBeenCalled()
  })

  it('should not call refreshMonitorConnection when socket is still alive for an unchanged instance', async () => {
    const username = 'AA:BB:CC:DD:EE:FF'

    const existingInstance = {
      name: 'Test Bridge',
      username,
      ipAddress: '127.0.0.1',
      port: 51826,
      services: [],
      connectionFailedCount: 0,
      configurationNumber: 1,
    };
    (hapClient as any).instances = [existingInstance]

    const refreshMonitorConnectionSpy = vi.fn()
      ; (hapClient as any).hapMonitor = {
      isInstanceConnected: vi.fn().mockReturnValue(true),
      isInstanceMonitored: vi.fn().mockReturnValue(true),
      refreshMonitorConnection: refreshMonitorConnectionSpy,
      finish: vi.fn(),
    }

    await upHandler({
      txt: { 'c#': 1, 'id': username, 'md': 'Test Bridge' },
      port: 51826,
      addresses: [],
    })

    expect(refreshMonitorConnectionSpy).not.toHaveBeenCalled()
  })
})

describe('hapClient bonjour up handler - missing id', () => {
  let hapClient: HapClient
  let upHandler: (device: any) => Promise<void>

  beforeEach(() => {
    hapClient = new HapClient({
      pin: '123-45-678',
      config: {
        autoStartDiscovery: false,
        instanceBlacklist: ['ZZ:ZZ:ZZ:ZZ:ZZ:ZZ'],
      },
    })
    hapClient.startDiscovery()

    const upCall = mockBrowserOn.mock.calls.find(([event]) => event === 'up')
    upHandler = upCall?.[1]
  })

  afterEach(() => {
    hapClient.destroy()
  })

  it('should not throw when device.txt.id is missing and a blacklist is configured', async () => {
    // Without the guard, instance.username = undefined and the blacklist check
    // calls `undefined.toLowerCase()`, which throws TypeError.
    await expect(upHandler({
      txt: { 'c#': 1, 'md': 'Test Bridge' },
      port: 51826,
      addresses: ['127.0.0.1'],
    })).resolves.toBeUndefined()

    // No instance should have been registered.
    expect((hapClient as any).instances.length).toBe(0)
  })

  it('should not throw when device.txt.id is empty string', async () => {
    await expect(upHandler({
      txt: { 'c#': 1, 'id': '', 'md': 'Test Bridge' },
      port: 51826,
      addresses: ['127.0.0.1'],
    })).resolves.toBeUndefined()

    expect((hapClient as any).instances.length).toBe(0)
  })
})

describe('hapClient bonjour up handler - a known bridge at a new address', () => {
  const username = 'AA:BB:CC:DD:EE:FF'
  let hapClient: HapClient
  let upHandler: (device: any) => Promise<void>
  let known: any

  beforeEach(() => {
    hapClient = new HapClient({
      pin: '123-45-678',
      config: { autoStartDiscovery: false },
    })
    hapClient.startDiscovery()
    upHandler = mockBrowserOn.mock.calls.find(([event]) => event === 'up')?.[1]
    known = {
      name: 'Test Bridge',
      username,
      ipAddress: '10.0.0.5',
      port: 51826,
      services: [],
      connectionFailedCount: 0,
      configurationNumber: 1,
    }
    ;(hapClient as any).instances = [known]
    mockFetch.mockResolvedValue(fetchResponse({ accessories: [] }))
  })

  afterEach(() => {
    hapClient.destroy()
  })

  const announce = () => upHandler({
    txt: { 'c#': 1, 'id': username, 'md': 'Test Bridge' },
    port: 51826,
    addresses: ['10.0.0.9'],
  })

  it('moves the bridge to the new address when the old one fails and the new one answers', async () => {
    known.connectionFailedCount = 2
    const discovered = vi.fn()
    hapClient.on('instance-discovered', discovered)

    await announce()

    expect((hapClient as any).instances).toEqual([known])
    expect(known).toMatchObject({ ipAddress: '10.0.0.9', connectionFailedCount: 0 })
    expect(discovered).toHaveBeenCalledWith(known)
    expect(mockFetch.mock.calls[0][0]).toBe('http://10.0.0.9:51826/accessories')
  })

  it('moves the bridge when the monitor has lost its connection', async () => {
    const updateInstance = vi.fn()
    ;(hapClient as any).hapMonitor = {
      updateInstance,
      refreshMonitorConnection: vi.fn(),
      isInstanceConnected: vi.fn().mockReturnValue(false),
      isInstanceMonitored: vi.fn().mockReturnValue(true),
      finish: vi.fn(),
    }
    ;(hapClient as any).getAllServices = vi.fn().mockResolvedValue([
      { instance: known, aid: 1 },
    ])

    await announce()

    expect(known.ipAddress).toBe('10.0.0.9')
    await vi.waitFor(() => expect(updateInstance).toHaveBeenCalledWith(known, [
      { instance: known, aid: 1 },
    ]))
  })

  it('keeps the old address when the new one does not answer', async () => {
    known.connectionFailedCount = 2
    mockFetch.mockRejectedValue(new TypeError('fetch failed'))

    await announce()

    expect((hapClient as any).instances).toEqual([known])
    expect(known.ipAddress).toBe('10.0.0.5')
  })

  it('still reconnects the monitor to the old address when the new one does not answer', async () => {
    const refreshMonitorConnection = vi.fn()
    ;(hapClient as any).hapMonitor = {
      refreshMonitorConnection,
      isInstanceConnected: vi.fn().mockReturnValue(false),
      isInstanceMonitored: vi.fn().mockReturnValue(true),
      finish: vi.fn(),
    }
    mockFetch.mockRejectedValue(new TypeError('fetch failed'))

    await announce()

    expect(known.ipAddress).toBe('10.0.0.5')
    expect(refreshMonitorConnection).toHaveBeenCalledWith(known)
  })

  it('does not probe another address while the known one works', async () => {
    await announce()

    expect(mockFetch).not.toHaveBeenCalled()
    expect(known.ipAddress).toBe('10.0.0.5')
  })
})

describe('hapClient bonjour up handler - deny list under both names', () => {
  it('ignores a bridge on instanceBlacklist when instanceDenyList is set but empty', async () => {
    const hapClient = new HapClient({
      pin: '123-45-678',
      config: {
        autoStartDiscovery: false,
        instanceDenyList: [],
        instanceBlacklist: ['AA:BB:CC:DD:EE:FF'],
      },
    })
    hapClient.startDiscovery()
    const upHandler = mockBrowserOn.mock.calls.find(([event]) => event === 'up')?.[1]
    mockFetch.mockResolvedValue(fetchResponse({ accessories: [] }))

    await upHandler({
      txt: { 'c#': 1, 'id': 'aa:bb:cc:dd:ee:ff', 'md': 'Test Bridge' },
      port: 51826,
      addresses: ['127.0.0.1'],
    })

    expect(mockFetch).not.toHaveBeenCalled()
    expect((hapClient as any).instances).toEqual([])
    hapClient.destroy()
  })
})

describe('hapClient bonjour up handler - empty addresses (#40)', () => {
  let hapClient: HapClient
  let upHandler: (device: any) => Promise<void>

  beforeEach(() => {
    hapClient = new HapClient({
      pin: '123-45-678',
      config: { autoStartDiscovery: false },
    })
    hapClient.startDiscovery()

    const upCall = mockBrowserOn.mock.calls.find(([event]) => event === 'up')
    upHandler = upCall?.[1]
  })

  afterEach(() => {
    hapClient.destroy()
    vi.mocked(lookup).mockReset()
  })

  it('resolves the hostname when bonjour-service supplies no addresses', async () => {
    // When several bridges share a hostname, the mDNS responder suppresses the
    // repeated A records, so bonjour-service hands us an empty addresses array.
    // Without the hostname fallback the bridge is dropped without being probed.
    vi.mocked(lookup).mockResolvedValue([
      { address: '192.168.1.50', family: 4 },
    ] as any)
    mockFetch.mockResolvedValue(fetchResponse({
      accessories: [
        { aid: 1, services: [] },
      ],
    }))

    await upHandler({
      txt: { 'c#': 1, 'id': 'AA:BB:CC:DD:EE:FF', 'md': 'Shared Host Bridge' },
      port: 51826,
      host: 'pi4b.local',
      addresses: [],
    })

    expect(vi.mocked(lookup)).toHaveBeenCalledWith('pi4b.local', { all: true, family: 4 })

    const instances = (hapClient as any).instances
    expect(instances.length).toBe(1)
    expect(instances[0].username).toBe('AA:BB:CC:DD:EE:FF')
    expect(instances[0].ipAddress).toBe('192.168.1.50')
  })

  it('does not resolve the hostname when a usable address is already supplied', async () => {
    mockFetch.mockResolvedValue(fetchResponse({
      accessories: [
        { aid: 1, services: [] },
      ],
    }))

    await upHandler({
      txt: { 'c#': 1, 'id': 'BB:CC:DD:EE:FF:AA', 'md': 'Normal Bridge' },
      port: 51827,
      host: 'pi4b.local',
      addresses: ['127.0.0.1'],
    })

    expect(vi.mocked(lookup)).not.toHaveBeenCalled()

    const instances = (hapClient as any).instances
    expect(instances.length).toBe(1)
    expect(instances[0].ipAddress).toBe('127.0.0.1')
  })

  it('does not throw when the hostname cannot be resolved', async () => {
    vi.mocked(lookup).mockRejectedValue(new Error('ENOTFOUND'))

    await expect(upHandler({
      txt: { 'c#': 1, 'id': 'CC:DD:EE:FF:AA:BB', 'md': 'Unresolvable Bridge' },
      port: 51828,
      host: 'does-not-exist.invalid',
      addresses: [],
    })).resolves.toBeUndefined()

    expect((hapClient as any).instances.length).toBe(0)
  })

  it('does not throw when addresses is missing entirely', async () => {
    await expect(upHandler({
      txt: { 'c#': 1, 'id': 'DD:EE:FF:AA:BB:CC', 'md': 'No Addresses Bridge' },
      port: 51829,
    })).resolves.toBeUndefined()
  })

  it('keeps probing the remaining addresses when one answers without an accessories list', async () => {
    // A 200 that carries no `accessories` is not a usable bridge - something
    // else on that port, or one still starting up. Breaking out of the probe
    // loop there left ipAddress null and the instance unregistered while a
    // working sibling address was never tried.
    mockFetch
      .mockResolvedValueOnce(fetchResponse({}))
      .mockResolvedValueOnce(fetchResponse({
        accessories: [
          { aid: 1, services: [] },
        ],
      }))
      .mockResolvedValue(fetchResponse({}))

    await upHandler({
      txt: { 'c#': 1, 'id': 'EE:FF:AA:BB:CC:DD', 'md': 'Multi Homed Bridge' },
      port: 51830,
      host: 'pi4b.local',
      addresses: ['192.168.1.60', '192.168.1.61'],
    })

    // Two calls probe the advertised addresses; a third call verifies the
    // selected address with a PUT before registering the instance.
    expect(mockFetch).toHaveBeenCalledTimes(3)

    expect(mockFetch.mock.calls[0][0]).toBe('http://192.168.1.60:51830/accessories')
    expect(mockFetch.mock.calls[1][0]).toBe('http://192.168.1.61:51830/accessories')
    expect(mockFetch.mock.calls[2][0]).toBe('http://192.168.1.61:51830/characteristics')
    expect(mockFetch.mock.calls[2][1]).toEqual(expect.objectContaining({ method: 'PUT' }))

    const instances = (hapClient as any).instances
    expect(instances.length).toBe(1)
    expect(instances[0].ipAddress).toBe('192.168.1.61')
  })
})

describe('hapClient getAccessories - failing instance removal', () => {
  let hapClient: HapClient

  beforeEach(() => {
    hapClient = new HapClient({
      pin: '123-45-678',
      config: { autoStartDiscovery: false },
    })
  })

  afterEach(() => {
    hapClient.destroy()
    vi.restoreAllMocks()
  })

  it('should not remove a healthy instance when the failing instance is no longer in the pool', async () => {
    // Reproduces a race where one caller removes the failing instance from
    // the pool before the catch handler in another concurrent getAccessories
    // call reaches the splice. With the bug, findIndex returns -1 and
    // splice(-1, 1) deletes the LAST element of the array (a healthy instance).
    const failingInstance = {
      name: 'Failing Bridge',
      username: 'AA:AA:AA:AA:AA:AA',
      ipAddress: '1.1.1.1',
      port: 80,
      services: [],
      connectionFailedCount: 5,
      configurationNumber: 1,
    }
    const healthyInstance = {
      name: 'Healthy Bridge',
      username: 'BB:BB:BB:BB:BB:BB',
      ipAddress: '2.2.2.2',
      port: 80,
      services: [],
      connectionFailedCount: 0,
      configurationNumber: 1,
    }
      ; (hapClient as any).instances = [failingInstance, healthyInstance]

    mockFetch.mockImplementation(async (url: string) => {
      if (url.includes('1.1.1.1')) {
        // Simulate the racing concurrent removal of the failing instance
        // before this catch handler reaches the splice.
        const idx = (hapClient as any).instances.indexOf(failingInstance)
        if (idx > -1) {
          (hapClient as any).instances.splice(idx, 1)
        }
        throw new Error('connection refused')
      }
      return fetchResponse({ accessories: [] })
    })

    await (hapClient as any).getAccessories()

    // With the fix: findIndex returns -1, splice is skipped, healthy instance remains.
    // With the bug: splice(-1, 1) would have removed healthyInstance.
    expect((hapClient as any).instances).toContain(healthyInstance)
  })

  it('still collects from the instance following one that gets removed', async () => {
    // The loop used to iterate this.instances directly while the catch handler
    // spliced from it. Removing the current element shifts the next one into
    // its index, and the for..of iterator moves past it - so the bridge sitting
    // immediately after an evicted one contributed no accessories to this call.
    const failing = {
      name: 'Failing Bridge',
      username: 'AA:AA:AA:AA:AA:AA',
      ipAddress: '1.1.1.1',
      port: 80,
      services: [],
      connectionFailedCount: 5, // one more failure evicts it
      configurationNumber: 1,
    }
    const nextInLine = {
      name: 'Next Bridge',
      username: 'BB:BB:BB:BB:BB:BB',
      ipAddress: '2.2.2.2',
      port: 80,
      services: [],
      connectionFailedCount: 0,
      configurationNumber: 1,
    }
      ; (hapClient as any).instances = [failing, nextInLine]

    mockFetch.mockImplementation(async (url: string) => {
      if (url.includes('1.1.1.1')) {
        throw new Error('connection refused')
      }
      return fetchResponse({
        accessories: [
          { aid: 1, services: [] },
        ],
      })
    })

    const accessories = await (hapClient as any).getAccessories()

    expect((hapClient as any).instances).not.toContain(failing)
    expect((hapClient as any).instances).toContain(nextInLine)
    // the surviving bridge was actually visited
    expect(accessories.length).toBe(1)
    expect(accessories[0].instance).toBe(nextInLine)
  })

  it.each([204, 200])('removes an instance after repeated empty %s accessories responses', async (status) => {
    const instance = {
      name: 'Empty Response Bridge',
      username: 'AA:AA:AA:AA:AA:AA',
      ipAddress: '1.1.1.1',
      port: 80,
      services: [],
      connectionFailedCount: 0,
      configurationNumber: 1,
    }
    ;(hapClient as any).instances = [instance]
    mockFetch.mockResolvedValue(fetchResponse('', status))

    for (let i = 0; i < 6; i++) {
      await (hapClient as any).getAccessories()
    }

    expect((hapClient as any).instances).not.toContain(instance)
  })
})

describe('hapClient resetInstancePool - stale discovery timeout', () => {
  let hapClient: HapClient

  beforeEach(() => {
    vi.useFakeTimers()
    hapClient = new HapClient({
      pin: '123-45-678',
      config: { autoStartDiscovery: false },
    })
  })

  afterEach(() => {
    hapClient.destroy()
    vi.useRealTimers()
  })

  it('should not end the new discovery early when reset happens before the previous 60s timeout', () => {
    // Discovery 1 starts at t=0 with a 60s timeout.
    hapClient.startDiscovery()

    // Reset at t=10s — without the fix the original 60s timeout is left pending.
    vi.advanceTimersByTime(10000)
    hapClient.resetInstancePool()

    // The reset's 6s timer fires refreshInstances, which starts discovery 2.
    const discoveryEndedSpy = vi.fn()
    hapClient.on('discovery-ended', discoveryEndedSpy)
    vi.advanceTimersByTime(6000) // t=16s, new discovery begins with its own 60s timer

    // Advance to t=60s — the *original* timeout's firing time.
    vi.advanceTimersByTime(44000)

    // With the bug: the stale 60s timeout fires here, stops the new browser
    // and emits 'discovery-ended' only 44s into the new discovery.
    // With the fix: it was cleared in resetInstancePool, so no event yet.
    expect(discoveryEndedSpy).not.toHaveBeenCalled()

    // The new discovery's own 60s should fire at t=76s.
    vi.advanceTimersByTime(16000) // t=76s
    expect(discoveryEndedSpy).toHaveBeenCalledTimes(1)
  })

  it('should not stack resetInstancePoolTimeouts when called repeatedly', () => {
    const refreshSpy = vi.spyOn(hapClient, 'refreshInstances').mockImplementation(() => { })

    hapClient.resetInstancePool()
    hapClient.resetInstancePool()
    hapClient.resetInstancePool()

    // Advance past the 6s delay.
    vi.advanceTimersByTime(6000)

    // With the bug each call set a new timeout without clearing the previous one,
    // so refreshInstances would have fired three times. With the fix it fires once.
    expect(refreshSpy).toHaveBeenCalledTimes(1)
  })

  it('should not throw when discoveryInProgress is true but the browser was never assigned', () => {
    // Simulates the state where startDiscovery set discoveryInProgress = true
    // and bonjour.find() then threw before assigning this.browser.
    (hapClient as any).discoveryInProgress = true
    ; (hapClient as any).browser = undefined

    expect(() => hapClient.resetInstancePool()).not.toThrow()
  })
})

describe('hapClient getAllServices - null Name characteristic value', () => {
  let hapClient: HapClient

  beforeEach(() => {
    hapClient = new HapClient({
      pin: '123-45-678',
      config: { autoStartDiscovery: false },
    })
  })

  afterEach(() => {
    hapClient.destroy()
    vi.restoreAllMocks()
  })

  it('should not throw when an accessory exposes a Name characteristic with a null value', async () => {
    // Switch service UUID + Name characteristic UUID, both in long form.
    const switchUuid = Services.Switch
    const onUuid = Characteristics.On

    const instance = {
      name: 'Test Bridge',
      username: 'AA:BB:CC:DD:EE:FF',
      ipAddress: '127.0.0.1',
      port: 51826,
      services: [],
      connectionFailedCount: 0,
      configurationNumber: 1,
    }
      ; (hapClient as any).instances = [instance]

    mockFetch.mockResolvedValue(fetchResponse({
      accessories: [
        {
          aid: 1,
          services: [
            {
              iid: 1,
              type: switchUuid,
              primary: true,
              hidden: false,
              characteristics: [
                // Name characteristic exists but value is null — the previous
                // fallback only fired when the characteristic was missing.
                {
                  iid: 2,
                  type: Characteristics.Name,
                  description: 'Name',
                  value: null,
                  format: 'string',
                  perms: ['pr'],
                },
                {
                  iid: 3,
                  type: onUuid,
                  description: 'On',
                  value: false,
                  format: 'bool',
                  perms: ['pr', 'pw', 'ev'],
                },
              ],
            },
          ],
        },
      ],
    }))

    // getAllServices() must resolve (not reject) when a Name characteristic
    // has a null value; awaiting it directly fails the test if it throws.
    const services = await hapClient.getAllServices()

    // Should fall back to the humanised service name.
    expect(services).toHaveLength(1)
    expect(services[0].serviceName).toBe('Switch')
  })

  it('gives the characteristics the name of their service when the Name characteristic is empty', async () => {
    ;(hapClient as any).instances = [
      {
        name: 'Test Bridge',
        username: 'AA:BB:CC:DD:EE:FF',
        ipAddress: '127.0.0.1',
        port: 51826,
        services: [],
        connectionFailedCount: 0,
        configurationNumber: '1',
      },
    ]
    mockFetch.mockResolvedValue(fetchResponse({
      accessories: [
        {
          aid: 2,
          services: [
            {
              iid: 1,
              type: Services.AccessoryInformation,
              characteristics: [
                {
                  iid: 2,
                  type: Characteristics.Name,
                  description: 'Name',
                  value: 'Lamp',
                  format: 'string',
                  perms: ['pr'],
                },
              ],
            },
            {
              iid: 8,
              type: Services.Switch,
              characteristics: [
                {
                  iid: 9,
                  type: Characteristics.Name,
                  description: 'Name',
                  value: '',
                  format: 'string',
                  perms: ['pr'],
                },
                {
                  iid: 10,
                  type: Characteristics.On,
                  description: 'On',
                  value: false,
                  format: 'bool',
                  perms: ['pr', 'pw', 'ev'],
                },
              ],
            },
          ],
        },
      ],
    }))

    const [service] = await hapClient.getAllServices()

    expect(service.serviceName).toBe('Lamp')
    expect(service.serviceCharacteristics.map(c => c.serviceName)).toEqual(['Lamp'])
  })
})

describe('hapClient refreshServiceCharacteristics - defensive entries', () => {
  let hapClient: HapClient

  function buildService() {
    return {
      aid: 1,
      iid: 1,
      uuid: '00000049-0000-1000-8000-0026BB765291',
      type: 'Switch',
      humanType: 'Switch',
      serviceName: 'My Switch',
      serviceCharacteristics: [
        {
          aid: 1,
          iid: 10,
          uuid: '00000025-0000-1000-8000-0026BB765291',
          type: 'On',
          serviceType: 'Switch',
          serviceName: 'My Switch',
          description: 'On',
          value: true,
          format: 'bool' as const,
          perms: ['pr', 'pw', 'ev'] as ('pr' | 'pw' | 'ev')[],
          canRead: true,
          canWrite: true,
          ev: true,
        },
      ],
      accessoryInformation: {},
      values: { On: true },
      instance: {
        name: 'Test Bridge',
        username: 'AA:BB:CC:DD:EE:FF',
        ipAddress: '127.0.0.1',
        port: 51826,
        services: [],
        connectionFailedCount: 0,
        configurationNumber: 1,
      },
    }
  }

  beforeEach(() => {
    hapClient = new HapClient({
      pin: '123-45-678',
      config: { autoStartDiscovery: false },
    })
  })

  afterEach(() => {
    hapClient.destroy()
    vi.restoreAllMocks()
  })

  it('should skip response characteristics whose iid is not in the service', async () => {
    const service = buildService() as any

    mockFetch.mockResolvedValue(fetchResponse({
      characteristics: [
        // iid 99 is not in the service — without the guard `characteristic.value = c.value` throws.
        { aid: 1, iid: 99, value: false },
      ],
    }))

    await expect(hapClient.refreshServiceCharacteristics(service)).resolves.toBe(service)

    // Cached value untouched because the only response entry was a stale iid.
    expect(service.serviceCharacteristics[0].value).toBe(true)
    expect(service.values.On).toBe(true)
  })

  it('should reject and preserve cached values when HAP returns a status error', async () => {
    const service = buildService() as any

    mockFetch.mockResolvedValue(fetchResponse({
      // HAP returns `{ aid, iid, status }` with no `value` field on per-char errors.
      // Without the guard `characteristic.value = c.value` overwrites `true` with `undefined`.
      characteristics: [
        { aid: 1, iid: 10, status: -70402 },
      ],
    }))

    await expect(hapClient.refreshServiceCharacteristics(service)).rejects.toThrow('Characteristic 1.10 returned HAP status -70402')

    expect(service.serviceCharacteristics[0].value).toBe(true)
    expect(service.values.On).toBe(true)
  })

  it('applies successful partial reads, records errors, and clears status on recovery', async () => {
    const service = buildService() as any
    service.serviceCharacteristics.push({ ...service.serviceCharacteristics[0], iid: 11, type: 'Other' })
    mockFetch.mockResolvedValue(fetchResponse({
      characteristics: [
        { aid: 1, iid: 10, status: -70402 },
        { aid: 1, iid: 11, value: false },
      ],
    }))
    const errorSpy = vi.spyOn(hapClient, 'error')
    await expect(hapClient.refreshServiceCharacteristics(service)).rejects.toThrow('HAP status -70402')
    expect(service.serviceCharacteristics[0]).toMatchObject({ value: true, status: -70402 })
    expect(service.serviceCharacteristics[1]).toMatchObject({ value: false, status: 0 })
    expect(service.values.Other).toBe(false)
    expect(errorSpy).not.toHaveBeenCalled()
    mockFetch.mockResolvedValue(fetchResponse({
      characteristics: [
        { aid: 1, iid: 10, value: false },
      ],
    }))
    await expect(hapClient.getCharacteristic(service, 10)).resolves.toMatchObject({ value: false, status: 0 })
  })

  it('does not request write-only characteristics or send empty requests', async () => {
    const service = buildService() as any
    service.serviceCharacteristics.push({ ...service.serviceCharacteristics[0], iid: 11, canRead: false })
    mockFetch.mockResolvedValue(fetchResponse({
      characteristics: [
        { aid: 1, iid: 10, value: true },
      ],
    }))
    await hapClient.refreshServiceCharacteristics(service)
    expect(mockFetch.mock.calls.at(-1)?.[0]).toEqual(
      expect.stringContaining('/characteristics?id=1.10'),
    )
    mockFetch.mockClear()
    service.serviceCharacteristics[0].canRead = false
    await expect(hapClient.refreshServiceCharacteristics(service)).resolves.toBe(service)
    expect(mockFetch).not.toHaveBeenCalled()
  })

  it('getCharacteristic should not log an error on an empty characteristics response', async () => {
    const service = buildService() as any

    // Build a client with a logger spy so we can assert nothing was logged as error.
    const errorSpy = vi.fn()
    const localClient = new HapClient({
      pin: '123-45-678',
      logger: {
        error: errorSpy,
        warn: vi.fn(),
        info: vi.fn(),
        debug: vi.fn(),
      },
      config: { autoStartDiscovery: false },
    })

    mockFetch.mockResolvedValue(fetchResponse({ characteristics: [] }))

    // Without the guard `resp.characteristics[0].iid` throws a TypeError that
    // the try/catch swallows — but the misleading "Failed to get characteristic"
    // error log is still emitted, polluting the user's logs.
    const result = await localClient.getCharacteristic(service, 10)
    expect(result).toBeUndefined()
    expect(errorSpy).not.toHaveBeenCalled()
    expect(service.serviceCharacteristics[0].value).toBe(true)

    localClient.destroy()
  })

  it('getCharacteristic should reject and preserve cached values on a status error', async () => {
    const service = buildService() as any

    mockFetch.mockResolvedValue(fetchResponse({
      characteristics: [
        { aid: 1, iid: 10, status: -70402 },
      ],
    }))

    await expect(hapClient.getCharacteristic(service, 10)).rejects.toThrow('Characteristic 1.10 returned HAP status -70402')

    expect(service.serviceCharacteristics[0].value).toBe(true)
    expect(service.values.On).toBe(true)
  })

  it('getCharacteristic logs the unparsed response body when raw logging is enabled', async () => {
    const service = buildService() as any
    const debug = vi.fn()
    const localClient = new HapClient({
      pin: '123-45-678',
      logger: { debug },
      config: { autoStartDiscovery: false, debug: true, debugRawPackets: true },
    })
    const rawBody = '{"characteristics":[{"aid":1,"iid":10,"value":false}]}'
    mockFetch.mockResolvedValue(
      fetchResponse(rawBody, 207, 'Multi-Status', {
        'content-length': String(Buffer.byteLength(rawBody)),
        'content-type': 'application/hap+json',
      }),
    )

    await expect(localClient.getCharacteristic(service, 10)).resolves.toMatchObject({ value: false })

    expect(debug).toHaveBeenCalledWith(
      '[HapClient] [127.0.0.1:51826 (AA:BB:CC:DD:EE:FF)] Raw getValue(1.10) request sent:\n'
      + 'GET /characteristics?id=1.10 HTTP/1.1\r\nHost: 127.0.0.1:51826\r\n\r\n',
    )
    expect(debug).toHaveBeenCalledWith(
      '[HapClient] [127.0.0.1:51826 (AA:BB:CC:DD:EE:FF)] Raw getValue(1.10) response:\n'
      + 'HTTP/1.1 207 Multi-Status\r\n'
      + `content-length: ${Buffer.byteLength(rawBody)}\r\n`
      + 'content-type: application/hap+json\r\n'
      + `\r\n${rawBody}`,
    )
    expect(mockFetch.mock.calls.at(-1)?.[0]).toEqual(
      expect.stringContaining('/characteristics?id=1.10'),
    )
    localClient.destroy()
  })

  it.each([0, undefined])('should accept successful reads with status %s', async (status) => {
    const service = buildService() as any
    mockFetch.mockResolvedValue(fetchResponse({
      characteristics: [
        {
          aid: 1,
          iid: 10,
          value: false,
          status,
        },
      ],
    }))

    await expect(hapClient.getCharacteristic(service, 10)).resolves.toMatchObject({ value: false })
    await expect(hapClient.refreshServiceCharacteristics(service)).resolves.toBe(service)
    expect(service.values.On).toBe(false)
  })

  it('refreshInstances should log when browser.update() throws instead of swallowing the error', () => {
    const debugSpy = vi.fn()
    const localClient = new HapClient({
      pin: '123-45-678',
      logger: {
        error: vi.fn(),
        warn: vi.fn(),
        info: vi.fn(),
        log: vi.fn(),
        debug: debugSpy,
      },
      config: { autoStartDiscovery: false, debug: true },
    })
    localClient.startDiscovery()

    // Force browser.update() to throw — without the fix the bare catch
    // block silently swallows it, hiding any underlying state corruption.
    const err = new Error('mdns socket not bound')
    mockBrowserUpdate.mockImplementation(() => {
      throw err
    })

    localClient.refreshInstances()

    const calls = debugSpy.mock.calls.map(c => c[0] as string)
    expect(calls.some(msg => msg.includes('Failed to re-broadcast') && msg.includes('mdns socket not bound'))).toBe(true)

    localClient.destroy()
  })

  it('stopDiscovery should remove listeners from the browser to avoid leaking handlers', () => {
    hapClient.startDiscovery()

    // Capture the current browser's spies before stopDiscovery wipes references.
    const capturedRemoveAllListeners = mockBrowserRemoveAllListeners

    hapClient.stopDiscovery()

    // Without the fix the old browser keeps its `up` listener attached even
    // though the browser is stopped — every subsequent startDiscovery created
    // a fresh browser, so handlers accumulate across cycles.
    expect(capturedRemoveAllListeners).toHaveBeenCalled()
  })

  it('setCharacteristicsByTypes leaves ConfiguredName out of the write and sends the rest', async () => {
    const service = buildService() as any
    service.serviceCharacteristics.push({
      aid: 1,
      iid: 11,
      uuid: '000000E3-0000-1000-8000-0026BB765291',
      // The type name as the generated list has it: no space
      type: 'ConfiguredName',
      serviceType: 'Switch',
      serviceName: 'My Switch',
      description: 'Configured Name',
      value: 'Foo',
      format: 'string',
      perms: ['pr', 'pw'],
      canRead: true,
      canWrite: true,
      ev: false,
    })
    const written = service.serviceCharacteristics[0]
    mockFetch.mockResolvedValue(fetchResponse('', 204, 'No Content'))

    await hapClient.setCharacteristicsByTypes(service, { [written.type]: true, ConfiguredName: 'Bar' })

    const put = mockFetch.mock.calls.find(([, options]) => options?.method === 'PUT')
    expect(JSON.parse(put![1].body)).toEqual({
      characteristics: [
        { aid: written.aid, iid: written.iid, value: true },
      ],
    })
  })

  it('setCharacteristicsByTypes sends nothing when only ConfiguredName is in the payload', async () => {
    const service = buildService() as any
    service.serviceCharacteristics.push({
      aid: 1,
      iid: 11,
      type: 'ConfiguredName',
      perms: ['pr', 'pw'],
      canRead: true,
    })

    await hapClient.setCharacteristicsByTypes(service, { ConfiguredName: 'Bar' })

    expect(mockFetch).not.toHaveBeenCalled()
  })

  it('getResource returns the body on success', async () => {
    const service = buildService() as any
    mockFetch.mockResolvedValueOnce(fetchResponse('jpeg'))

    const data = await hapClient.getResource(service, { 'resource-type': 'image', 'image-width': 640, 'image-height': 360 } as any)

    expect(data?.toString()).toBe('jpeg')
  })

  // Under axios an HTTP error status rejected; fetch resolves, and getResource
  // returned undefined without naming a refused pin.
  it.each([470, 401])('getResource rejects and names the pin when HAP returns %s', async (status) => {
    const service = buildService() as any
    mockFetch.mockResolvedValueOnce(fetchResponse('', status, 'Unauthorized'))

    await expect(hapClient.getResource(service, {} as any)).rejects.toThrow('Make sure the Homebridge pin')
  })

  it('getResource rejects on any other HTTP error status', async () => {
    const service = buildService() as any
    mockFetch.mockResolvedValueOnce(fetchResponse('', 500, 'Internal Server Error'))

    await expect(hapClient.getResource(service, {} as any)).rejects.toThrow('Failed to request resource: HTTP 500 Internal Server Error')
  })

  it.each([204, 200])('setCharacteristic should resolve when HAP returns an empty %s write response', async (status) => {
    const service = buildService() as any

    mockFetch
      .mockResolvedValueOnce(fetchResponse('', status))
      .mockResolvedValueOnce(fetchResponse({
        characteristics: [
          { aid: 1, iid: 10, value: false },
        ],
      }))

    const characteristic = await hapClient.setCharacteristic(service, 10, false)

    // A successful HAP write responds with an empty 204. Parsing that body as
    // JSON threw, so the caller treated a successful write as a failure.
    expect(characteristic?.value).toBe(false)
    expect(service.values.On).toBe(false)
  })
})

describe('hapClient monitorCharacteristics - replacing existing monitor', () => {
  let hapClient: HapClient

  beforeEach(() => {
    hapClient = new HapClient({
      pin: '123-45-678',
      config: { autoStartDiscovery: false },
    })
  })

  afterEach(() => {
    hapClient.destroy()
  })

  it('should call finish() on the previous monitor before replacing it', async () => {
    const previousFinish = vi.fn()
      ; (hapClient as any).hapMonitor = { finish: previousFinish }

    // Pass an empty services array so HapMonitor construction doesn't try to open sockets.
    await hapClient.monitorCharacteristics([])

    // Without the fix the previous monitor was overwritten without finish(),
    // leaking all of its open sockets.
    expect(previousFinish).toHaveBeenCalledTimes(1)
  })
})

/**
 * A bridge in insecure mode still checks the `Authorization` header against ITS
 * OWN pincode. Sending the main bridge's pin to every instance therefore works
 * only while every child bridge inherits it - a child with its own
 * `_bridge.pin` answers 470, gets dropped from discovery, and its accessories
 * silently vanish from the UI (homebridge-config-ui-x#2936).
 */
describe('hapClient per-bridge pins (#2936)', () => {
  const instance = (username: string, name = 'homebridge') => ({
    username,
    name,
    ipAddress: '10.0.0.1',
    port: 51826,
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  it('uses a bridge\'s own pin when one was supplied', () => {
    const client = new HapClient({
      pin: '123-45-678',
      pins: { '0E:AA:BB:CC:DD:EE': '999-88-777' },
      config: { autoStartDiscovery: false },
    })

    expect((client as any).pinFor(instance('0E:AA:BB:CC:DD:EE'))).toBe('999-88-777')
  })

  it('falls back to the main pin for a bridge that has none of its own', () => {
    const client = new HapClient({
      pin: '123-45-678',
      pins: { '0E:AA:BB:CC:DD:EE': '999-88-777' },
      config: { autoStartDiscovery: false },
    })

    expect((client as any).pinFor(instance('0E:11:22:33:44:55'))).toBe('123-45-678')
  })

  // Usernames are MACs and reach us from mDNS txt records, so do not assume the
  // case matches whatever the config file used.
  it('matches the username regardless of case', () => {
    const client = new HapClient({
      pin: '123-45-678',
      pins: { '0e:aa:bb:cc:dd:ee': '999-88-777' },
      config: { autoStartDiscovery: false },
    })

    expect((client as any).pinFor(instance('0E:AA:BB:CC:DD:EE'))).toBe('999-88-777')
  })

  it('still works when no per-bridge pins are given at all', () => {
    const client = new HapClient({
      pin: '123-45-678',
      config: { autoStartDiscovery: false },
    })

    expect((client as any).pinFor(instance('0E:AA:BB:CC:DD:EE'))).toBe('123-45-678')
  })

  it('sends the bridge\'s own pin when probing it', async () => {
    const client = new HapClient({
      pin: '123-45-678',
      pins: { '0E:AA:BB:CC:DD:EE': '999-88-777' },
      config: { autoStartDiscovery: false },
    })
    mockFetch.mockResolvedValueOnce(fetchResponse({}))

    await (client as any).checkInstanceConnection(instance('0E:AA:BB:CC:DD:EE'))

    expect(mockFetch).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        method: 'PUT',
        headers: expect.objectContaining({
          Authorization: '999-88-777',
        }),
        body: expect.any(String),
      }),
    )
  })

  // Without this the log said only "returned an error", which reads as a
  // network or discovery fault - the bridge answered, it just refused the pin.
  it('names the pin as the cause when a bridge answers 470', async () => {
    const warn = vi.fn()
    const client = new HapClient({
      pin: '123-45-678',
      logger: {
        warn,
        debug: vi.fn(),
        info: vi.fn(),
        error: vi.fn(),
      },
      config: { autoStartDiscovery: false },
    })
    mockFetch.mockResolvedValueOnce(fetchResponse({}, 470, ''))

    const ok = await (client as any).checkInstanceConnection(instance('0E:AA:BB:CC:DD:EE'))

    expect(ok).toBe(false)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('refused the pin'))
  })

  // Discovery re-probes on a timer, so an unchanged mismatch used to reprint the
  // same warning for as long as it lasted. A user running a second Homebridge
  // install cannot fix the other one's pin, so for them it never stopped (#2979).
  //
  // ⚠️ A bridge that refuses the pin is never registered, so every probe hands
  // over a FRESH instance object - the first fix flagged the object and was
  // defeated by exactly that. The test has to build a new object each time.
  it('names the pin once per bridge, however many discovery cycles probe it', async () => {
    const warn = vi.fn()
    const client = new HapClient({
      pin: '123-45-678',
      logger: {
        warn,
        debug: vi.fn(),
        info: vi.fn(),
        error: vi.fn(),
      },
      config: { autoStartDiscovery: false },
    })
    mockFetch.mockResolvedValue(fetchResponse({}, 470, ''))

    await (client as any).checkInstanceConnection(instance('0E:AA:BB:CC:DD:EE'))
    await (client as any).checkInstanceConnection(instance('0e:aa:bb:cc:dd:ee'))
    await (client as any).checkInstanceConnection(instance('0E:AA:BB:CC:DD:EE'))

    expect(warn).toHaveBeenCalledTimes(1)
  })

  // Discovery finds every Homebridge on the LAN, including other people's. Their
  // bridges refuse our pin by design, and telling the reader to "set the pin"
  // is advice they cannot act on (#2979, #3001) - so when the caller says
  // which bridges are its own, a stranger's refusal is a debug line only.
  it('logs another homebridge\'s refusal at debug once told which bridges are ours', async () => {
    const warn = vi.fn()
    const debug = vi.fn()
    const client = new HapClient({
      pin: '123-45-678',
      ownUsernames: ['0e:aa:bb:cc:dd:ee'],
      logger: {
        warn,
        debug,
        info: vi.fn(),
        error: vi.fn(),
      },
      config: { autoStartDiscovery: false, debug: true },
    })
    mockFetch.mockResolvedValueOnce(fetchResponse({ status: -70401 }, 470, 'Unknown'))

    await (client as any).checkInstanceConnection(instance('0E:11:22:33:44:55'))

    expect(warn).not.toHaveBeenCalled()
    expect(debug).toHaveBeenCalledWith(expect.stringContaining('another Homebridge on the network'))
  })

  it('still warns when one of our own bridges refuses the pin', async () => {
    const warn = vi.fn()
    const client = new HapClient({
      pin: '123-45-678',
      ownUsernames: ['0e:aa:bb:cc:dd:ee'],
      logger: {
        warn,
        debug: vi.fn(),
        info: vi.fn(),
        error: vi.fn(),
      },
      config: { autoStartDiscovery: false },
    })
    mockFetch.mockResolvedValueOnce(fetchResponse({ status: -70401 }, 470, 'Unknown'))

    await (client as any).checkInstanceConnection(instance('0E:AA:BB:CC:DD:EE'))

    expect(warn).toHaveBeenCalledWith(expect.stringContaining('refused the pin'))
  })

  it('reports a refusal again once the bridge has accepted the pin in between', async () => {
    const warn = vi.fn()
    const client = new HapClient({
      pin: '123-45-678',
      logger: {
        warn,
        debug: vi.fn(),
        info: vi.fn(),
        error: vi.fn(),
      },
      config: { autoStartDiscovery: false },
    })
    const refused = () => fetchResponse({ status: -70401 }, 470, 'Unknown')

    mockFetch.mockResolvedValueOnce(refused())
    await (client as any).checkInstanceConnection(instance('0E:AA:BB:CC:DD:EE'))
    mockFetch.mockResolvedValueOnce(fetchResponse({}))
    await (client as any).checkInstanceConnection(instance('0E:AA:BB:CC:DD:EE'))
    mockFetch.mockResolvedValueOnce(refused())
    await (client as any).checkInstanceConnection(instance('0E:AA:BB:CC:DD:EE'))

    expect(warn).toHaveBeenCalledTimes(2)
  })

  // Silencing it permanently would be the opposite mistake: a pin corrected and
  // then broken again is a real fault the user still needs telling about.
  it('names the pin again after a working connection in between', async () => {
    const warn = vi.fn()
    const client = new HapClient({
      pin: '123-45-678',
      logger: {
        warn,
        debug: vi.fn(),
        info: vi.fn(),
        error: vi.fn(),
      },
      config: { autoStartDiscovery: false },
    })
    const target = instance('0E:AA:BB:CC:DD:EE')

    mockFetch.mockResolvedValueOnce(fetchResponse({}, 470, ''))
    await (client as any).checkInstanceConnection(target)

    mockFetch.mockResolvedValueOnce(fetchResponse({}))
    await (client as any).checkInstanceConnection(target)

    mockFetch.mockResolvedValueOnce(fetchResponse({}, 470, ''))
    await (client as any).checkInstanceConnection(target)

    expect(warn).toHaveBeenCalledTimes(2)
  })

  // Discovery browses `_hap._tcp`, so it probes every HomeKit accessory on the
  // network - a Hue bridge, a HomePod, another HAP server such as Scrypted on
  // the same host. Those refuse the pin because they belong to Apple Home, and
  // telling their owner to set "the Homebridge pin" is advice they cannot act on.
  it('stays quiet when the device refusing the pin is not a homebridge bridge', async () => {
    const warn = vi.fn()
    const client = new HapClient({
      pin: '123-45-678',
      logger: {
        warn,
        debug: vi.fn(),
        info: vi.fn(),
        error: vi.fn(),
      },
      config: { autoStartDiscovery: false },
    })
    mockFetch.mockResolvedValueOnce(fetchResponse({}, 470, ''))

    // md=Scrypted, as a non-Homebridge HAP server advertises
    const ok = await (client as any).checkInstanceConnection(instance('32:46:85:f8:7b:a7', 'Scrypted'))

    expect(ok).toBe(false)
    expect(warn).not.toHaveBeenCalled()
  })
})

describe('hapClient writes', () => {
  let hapClient: HapClient

  function buildService() {
    const instance = {
      name: 'homebridge',
      username: 'AA:BB:CC:DD:EE:FF',
      ipAddress: '127.0.0.1',
      port: 51826,
      services: [],
      connectionFailedCount: 0,
      configurationNumber: 1,
    }
    const characteristic = (iid: number, type: string, perms: string[]) => ({
      aid: 2,
      iid,
      uuid: '00000000-0000-1000-8000-0026BB765291',
      type,
      serviceType: 'Television',
      serviceName: 'TV',
      description: type,
      value: 0,
      format: 'uint8',
      perms,
      canRead: perms.includes('pr'),
      canWrite: perms.includes('pw'),
      ev: perms.includes('ev'),
    })
    return {
      aid: 2,
      iid: 8,
      uuid: '000000D8-0000-1000-8000-0026BB765291',
      type: 'Television',
      humanType: 'Television',
      serviceName: 'TV',
      serviceCharacteristics: [
        characteristic(10, 'Active', ['pr', 'pw', 'ev']),
        characteristic(13, 'RemoteKey', ['pw']),
      ],
      accessoryInformation: {},
      values: {},
      instance,
    } as any
  }

  beforeEach(() => {
    hapClient = new HapClient({
      pin: '123-45-678',
      logger: {
        error: vi.fn(),
        warn: vi.fn(),
      },
      config: { autoStartDiscovery: false },
    })
  })

  afterEach(() => {
    hapClient.destroy()
  })

  it('does not read back a write-only characteristic after writing it', async () => {
    const service = buildService()
    // What HAP-NodeJS answers: 204 to the write, and a write-only status to any read
    mockFetch.mockImplementation(async (_url: string, options?: { method?: string }) => options?.method === 'PUT'
      ? fetchResponse('', 204, 'No Content')
      : fetchResponse({
          characteristics: [
            { aid: 2, iid: 13, status: -70405 },
          ],
        }, 207, 'Multi-Status'))

    const result = await hapClient.setCharacteristic(service, 13, 4)

    expect(result).toBe(service.serviceCharacteristics[1])
    expect(mockFetch).toHaveBeenCalledTimes(1)
    expect(mockFetch.mock.calls[0][1].method).toBe('PUT')
  })

  it('rejects a write the bridge refused instead of reporting success', async () => {
    const service = buildService()
    // HAP-NodeJS answers 207 with a status per characteristic when a set handler fails
    mockFetch.mockImplementation(async (_url: string, options?: { method?: string }) => options?.method === 'PUT'
      ? fetchResponse({
          characteristics: [
            { aid: 2, iid: 10, status: -70402 },
          ],
        }, 207, 'Multi-Status')
      : fetchResponse({
          characteristics: [
            { aid: 2, iid: 10, value: 0 },
          ],
        }))

    await expect(hapClient.setCharacteristic(service, 10, 1)).rejects.toMatchObject({
      name: 'HapCharacteristicError',
      message: 'Characteristic 2.10 returned HAP status -70402',
    })
    expect(mockFetch).toHaveBeenCalledTimes(1)
  })

  it('exports the error class, and the error names the characteristic and the status', async () => {
    const service = buildService()
    mockFetch.mockResolvedValue(fetchResponse({
      characteristics: [
        { aid: 2, iid: 10, status: -70402 },
      ],
    }, 207, 'Multi-Status'))

    const error = await hapClient.setCharacteristic(service, 10, 1).catch((e: unknown) => e)

    expect(error).toBeInstanceOf(HapCharacteristicError)
    expect(error).toMatchObject({ aid: 2, iid: 10, status: -70402 })
  })

  it('rejects a write of several characteristics when the bridge refused one of them', async () => {
    const service = buildService()
    mockFetch.mockImplementation(async (_url: string, options?: { method?: string }) => options?.method === 'PUT'
      ? fetchResponse({
          characteristics: [
            { aid: 2, iid: 10, status: 0 },
            { aid: 2, iid: 13, status: -70402 },
          ],
        }, 207, 'Multi-Status')
      : fetchResponse({
          characteristics: [
            { aid: 2, iid: 10, value: 1 },
          ],
        }))

    await expect(hapClient.setCharacteristicsByTypes(service, { Active: 1, RemoteKey: 4 })).rejects.toMatchObject({
      name: 'HapCharacteristicError',
      message: 'Characteristic 2.13 returned HAP status -70402',
    })
  })

  it.each([
    [
      'setCharacteristic',
      (service: any) => hapClient.setCharacteristic(service, 10, 1),
    ],
    [
      'setCharacteristics',
      (service: any) => hapClient.setCharacteristics(service, [
        { aid: 2, iid: 10, value: 1 },
      ]),
    ],
  ])('%s names the pin when the bridge refuses it, and the status otherwise', async (_name, write) => {
    const service = buildService()
    const logger = (hapClient as any).logger

    mockFetch.mockResolvedValue(fetchResponse({ status: -70401 }, 470, ''))
    await expect(write(service)).rejects.toThrow('Failed to control accessory. Make sure the Homebridge pin for 127.0.0.1:51826 is set to 123-45-678.')
    expect(logger.error).toHaveBeenCalledWith('[HapClient] [127.0.0.1:51826 (AA:BB:CC:DD:EE:FF)] Failed to set value for TV.')
    expect(logger.warn).toHaveBeenCalledWith('[HapClient] [127.0.0.1:51826 (AA:BB:CC:DD:EE:FF)] Make sure Homebridge pin for this instance is set to 123-45-678.')

    mockFetch.mockResolvedValue(fetchResponse('', 500, 'Internal Server Error'))
    await expect(write(service)).rejects.toThrow('Failed to control accessory: HTTP 500 Internal Server Error')
    expect(logger.error).toHaveBeenCalledWith('HTTP 500 Internal Server Error')
  })

  it('resolves a write that worked when the read back finds the accessory not responding', async () => {
    const service = buildService()
    mockFetch.mockImplementation(async (_url: string, options?: { method?: string }) => options?.method === 'PUT'
      ? fetchResponse('', 204, 'No Content')
      : fetchResponse({
          characteristics: [
            { aid: 2, iid: 10, status: -70402 },
          ],
        }, 207, 'Multi-Status'))

    // a rejection here read the same as a write the bridge refused
    const result = await hapClient.setCharacteristic(service, 10, 1)

    expect(result).toBe(service.serviceCharacteristics[0])
    expect(result?.status).toBe(-70402)
  })

  it('resolves a write of several values that worked when the read back finds a part not responding', async () => {
    const service = buildService()
    mockFetch.mockImplementation(async (_url: string, options?: { method?: string }) => options?.method === 'PUT'
      ? fetchResponse('', 204, 'No Content')
      : fetchResponse({
          characteristics: [
            { aid: 2, iid: 10, status: -70402 },
          ],
        }, 207, 'Multi-Status'))

    const result = await hapClient.setCharacteristics(service, [
      { aid: 2, iid: 10, value: 1 },
    ])

    expect(result).toBe(service)
    expect(service.serviceCharacteristics[0].status).toBe(-70402)
  })

  it('still reads back a readable characteristic after writing it', async () => {
    const service = buildService()
    mockFetch.mockImplementation(async (_url: string, options?: { method?: string }) => options?.method === 'PUT'
      ? fetchResponse('', 204, 'No Content')
      : fetchResponse({
          characteristics: [
            { aid: 2, iid: 10, value: 1 },
          ],
        }))

    const result = await hapClient.setCharacteristic(service, 10, 1)

    expect(result?.value).toBe(1)
    expect(mockFetch).toHaveBeenCalledTimes(2)
  })
})

describe('hapClient discovery probes that finish late', () => {
  let hapClient: HapClient
  let upHandler: (device: any) => Promise<void>
  let answer: (() => void) | undefined

  const device = {
    txt: { 'c#': '1', 'id': 'AA:BB:CC:DD:EE:FF', 'md': 'homebridge' },
    port: 51826,
    host: 'pi.local',
    addresses: ['192.168.1.10'],
  }

  /** The bridge answers every request, but the first one only once `answer()` is called. */
  function holdFirstRequest() {
    let first = true
    mockFetch.mockImplementation(async (_url: string, options?: { method?: string }) => {
      if (first) {
        first = false
        await new Promise<void>((resolve) => {
          answer = resolve
        })
      }
      return options?.method === 'PUT'
        ? fetchResponse('', 204, 'No Content')
        : fetchResponse({ accessories: [] })
    })
  }

  beforeEach(() => {
    hapClient = new HapClient({
      pin: '123-45-678',
      config: { autoStartDiscovery: false },
    })
    hapClient.startDiscovery()
    upHandler = mockBrowserOn.mock.calls.find(([event]) => event === 'up')?.[1]
  })

  afterEach(() => {
    hapClient.destroy()
  })

  it.each([
    [
      'resetInstancePool',
      () => hapClient.resetInstancePool(),
    ],
    [
      'stopDiscovery',
      () => hapClient.stopDiscovery(),
    ],
    [
      'destroy',
      () => hapClient.destroy(),
    ],
  ])('does not register a bridge whose probe finishes after %s()', async (_name, interrupt) => {
    const discovered = vi.fn()
    hapClient.on('instance-discovered', discovered)
    holdFirstRequest()

    const probe = upHandler(device)
    await vi.waitFor(() => expect(answer).toBeDefined())
    interrupt()
    answer!()
    await probe

    expect((hapClient as any).instances).toEqual([])
    expect(discovered).not.toHaveBeenCalled()
  })

  it('registers a bridge once when two probes of it overlap', async () => {
    const discovered = vi.fn()
    hapClient.on('instance-discovered', discovered)
    holdFirstRequest()

    const first = upHandler(device)
    await vi.waitFor(() => expect(answer).toBeDefined())
    const second = upHandler(device)
    await second
    answer!()
    await first

    expect((hapClient as any).instances).toHaveLength(1)
    expect(discovered).toHaveBeenCalledTimes(1)
  })

  it('does not hand a bridge to the monitor once the client was destroyed', async () => {
    const updateInstance = vi.fn()
    ;(hapClient as any).hapMonitor = {
      updateInstance,
      refreshMonitorConnection: vi.fn(),
      finish: vi.fn(),
    }
    holdFirstRequest()

    const sync = (hapClient as any).syncMonitorInstance({
      name: 'homebridge',
      username: 'AA:BB:CC:DD:EE:FF',
      ipAddress: '192.168.1.10',
      port: 51826,
      services: [],
      connectionFailedCount: 0,
      configurationNumber: '1',
    })
    await vi.waitFor(() => expect(answer).toBeDefined())
    hapClient.destroy()
    answer!()
    await sync

    expect(updateInstance).not.toHaveBeenCalled()
  })
})

describe('hapClient discovery - changes to a known bridge', () => {
  let hapClient: HapClient
  let instance: any

  const handlerFor = (event: string): (device: any) => Promise<void> =>
    mockBrowserOn.mock.calls.find(([name]) => name === event)?.[1]

  beforeEach(() => {
    hapClient = new HapClient({
      pin: '123-45-678',
      config: { autoStartDiscovery: false },
    })
    hapClient.startDiscovery()
    instance = {
      name: 'homebridge',
      username: 'AA:BB:CC:DD:EE:FF',
      ipAddress: '192.168.1.10',
      port: 51826,
      services: [],
      connectionFailedCount: 0,
      configurationNumber: '1',
    }
    ;(hapClient as any).instances = [instance]
  })

  afterEach(() => {
    hapClient.destroy()
  })

  // bonjour-service only emits 'up' for a service it has not seen before. A
  // change to a known one arrives as 'txt-update' (c#) or 'srv-update' (port).
  it('notices a new configuration number that bonjour-service reports as txt-update', async () => {
    const changed = vi.fn()
    hapClient.on('instance-configuration-changed', changed)

    await handlerFor('txt-update')({
      txt: { 'c#': '2', 'id': 'AA:BB:CC:DD:EE:FF', 'md': 'homebridge' },
      port: 51826,
    })

    expect(changed).toHaveBeenCalledExactlyOnceWith(instance)
    expect(instance.configurationNumber).toBe('2')
  })

  it('notices a new port that bonjour-service reports as srv-update', async () => {
    const discovered = vi.fn()
    hapClient.on('instance-discovered', discovered)

    await handlerFor('srv-update')({
      txt: { 'c#': '1', 'id': 'AA:BB:CC:DD:EE:FF', 'md': 'homebridge' },
      port: 51900,
    })

    expect(discovered).toHaveBeenCalledExactlyOnceWith(instance)
    expect(instance.port).toBe(51900)
  })
})

describe('hapClient request time limits', () => {
  let hapClient: HapClient
  let timeout: ReturnType<typeof vi.spyOn>

  const instance = {
    name: 'homebridge',
    username: 'AA:BB:CC:DD:EE:FF',
    ipAddress: '127.0.0.1',
    port: 51826,
    services: [],
    connectionFailedCount: 0,
    configurationNumber: '1',
  }
  const service = {
    aid: 2,
    iid: 8,
    serviceName: 'Camera',
    serviceCharacteristics: [
      {
        aid: 2,
        iid: 10,
        type: 'On',
        canRead: true,
        perms: ['pr', 'pw'],
      },
    ],
    values: {},
    instance,
  } as any

  beforeEach(() => {
    timeout = vi.spyOn(AbortSignal, 'timeout')
    hapClient = new HapClient({
      pin: '123-45-678',
      logger: {
        error: vi.fn(),
        warn: vi.fn(),
      },
      config: { autoStartDiscovery: false },
    })
    ;(hapClient as any).instances = [instance]
    mockFetch.mockImplementation(async (url: string) => fetchResponse(url.endsWith('/accessories')
      ? { accessories: [] }
      : {
          characteristics: [
            { aid: 2, iid: 10, value: 1 },
          ],
        }))
  })

  afterEach(() => {
    hapClient.destroy()
    timeout.mockRestore()
  })

  // Without a signal, fetch waits five minutes for a bridge that accepted the
  // connection and then went silent.
  it.each([
    [
      'getAllServices',
      15000,
      () => hapClient.getAllServices(),
    ],
    [
      'refreshServiceCharacteristics',
      15000,
      () => hapClient.refreshServiceCharacteristics(service),
    ],
    [
      'getCharacteristic',
      15000,
      () => hapClient.getCharacteristic(service, 10),
    ],
    [
      'setCharacteristics',
      15000,
      () => hapClient.setCharacteristics(service, [
        { aid: 2, iid: 10, value: 1 },
      ]),
    ],
    [
      'the pin check',
      15000,
      () => (hapClient as any).checkInstanceConnection(instance),
    ],
    [
      'getResource',
      30000,
      () => hapClient.getResource(service, { 'resource-type': 'image', 'image-width': 1, 'image-height': 1 }),
    ],
  ])('gives up on %s after %i ms', async (_name, limit, request) => {
    await request()

    expect(mockFetch).toHaveBeenCalled()
    for (const [, options] of mockFetch.mock.calls) {
      expect(options?.signal).toBeInstanceOf(AbortSignal)
    }
    expect(timeout.mock.calls.map((call: unknown[]) => call[0])).toEqual(mockFetch.mock.calls.map(() => limit))
  })
})

describe('hapClient getAllServices - unique ids', () => {
  let hapClient: HapClient

  const switchService = (iid: number) => ({
    iid,
    type: '49',
    characteristics: [
      {
        iid: iid + 1,
        type: '25',
        description: 'On',
        value: false,
        format: 'bool',
        perms: ['pr', 'pw', 'ev'],
      },
    ],
  })

  beforeEach(() => {
    hapClient = new HapClient({
      pin: '123-45-678',
      config: { autoStartDiscovery: false },
    })
    ;(hapClient as any).instances = [
      {
        name: 'homebridge',
        username: 'AA:BB:CC:DD:EE:FF',
        ipAddress: '127.0.0.1',
        port: 51826,
        services: [],
        connectionFailedCount: 0,
        configurationNumber: '1',
      },
    ]
    // Accessory 1 service 18 and accessory 11 service 8: joined without a
    // separator both read "118".
    mockFetch.mockResolvedValue(fetchResponse({
      accessories: [
        {
          aid: 1,
          services: [
            switchService(18),
          ],
        },
        {
          aid: 11,
          services: [
            switchService(8),
          ],
        },
      ],
    }))
  })

  afterEach(() => {
    hapClient.destroy()
  })

  it('gives two services whose accessory and service numbers join to the same text different unique ids', async () => {
    const [first, second] = await hapClient.getAllServices()

    expect(first.uniqueId).toMatch(/^[0-9a-f]{64}$/)
    expect(second.uniqueId).toMatch(/^[0-9a-f]{64}$/)
    expect(first.uniqueId).not.toBe(second.uniqueId)
  })

  it('keeps the id as it was built before in legacyUniqueId', async () => {
    const [first, second] = await hapClient.getAllServices()

    // sha256 of 'AA:BB:CC:DD:EE:FF118Switch', the id both services had up to v5.4.0
    expect(first.legacyUniqueId).toBe('11f778f3a72ab495aaf92329caca841c2ee5d51f3288cfa4afefeda6e163ba09')
    expect(second.legacyUniqueId).toBe(first.legacyUniqueId)
  })
})

describe('hapClient debug logging cost', () => {
  function stackTracesBuiltBy(client: HapClient): number {
    const original = Error.prepareStackTrace
    const prepare = vi.fn((error: Error) => String(error))
    Error.prepareStackTrace = prepare
    try {
      client.debug('a debug line')
    } finally {
      Error.prepareStackTrace = original
      client.destroy()
    }
    return prepare.mock.calls.length
  }

  it('builds no stack trace for a debug line while debug logging is off', () => {
    const debug = vi.fn()
    const client = new HapClient({
      pin: '123-45-678',
      logger: { debug },
      config: { autoStartDiscovery: false },
    })

    expect(stackTracesBuiltBy(client)).toBe(0)
    expect(debug).not.toHaveBeenCalled()
  })

  it('still adds the calling line to a debug line while debug logging is on', () => {
    const debug = vi.fn()
    const client = new HapClient({
      pin: '123-45-678',
      logger: { debug },
      config: { autoStartDiscovery: false, debug: true },
    })

    expect(stackTracesBuiltBy(client)).toBe(1)
    expect(debug).toHaveBeenCalledExactlyOnceWith(expect.stringMatching(/^a debug line @ /))
  })
})

describe('hapClient getAllServices - several bridges', () => {
  let hapClient: HapClient

  const bridge = (ipAddress: string) => ({
    name: 'homebridge',
    username: `AA:BB:CC:DD:EE:${ipAddress.slice(-2)}`,
    ipAddress,
    port: 51826,
    services: [],
    connectionFailedCount: 0,
    configurationNumber: '1',
  })
  const accessories = (name: string) => ({
    accessories: [
      {
        aid: 2,
        services: [
          {
            iid: 8,
            type: '49',
            characteristics: [
              {
                iid: 9,
                type: '23',
                description: 'Name',
                value: name,
                format: 'string',
                perms: ['pr'],
              },
              {
                iid: 10,
                type: '25',
                description: 'On',
                value: false,
                format: 'bool',
                perms: ['pr', 'pw', 'ev'],
              },
            ],
          },
        ],
      },
    ],
  })

  beforeEach(() => {
    hapClient = new HapClient({
      pin: '123-45-678',
      config: { autoStartDiscovery: false },
    })
    ;(hapClient as any).instances = [
      bridge('10.0.0.11'),
      bridge('10.0.0.12'),
      bridge('10.0.0.13'),
    ]
  })

  afterEach(() => {
    hapClient.destroy()
  })

  it('asks every bridge at the same time and keeps the bridges in order', async () => {
    const answers = new Map<string, () => void>()
    mockFetch.mockImplementation(async (url: string) => {
      const host = new URL(url).hostname
      await new Promise<void>((resolve) => {
        answers.set(host, resolve)
      })
      return fetchResponse(accessories(`Switch on ${host}`))
    })

    const result = hapClient.getAllServices()
    // All three requests are out before any bridge has answered
    await vi.waitFor(() => expect(answers.size).toBe(3))
    // The last bridge answers first
    answers.get('10.0.0.13')!()
    answers.get('10.0.0.12')!()
    answers.get('10.0.0.11')!()

    expect((await result).map(service => service.serviceName)).toEqual([
      'Switch on 10.0.0.11',
      'Switch on 10.0.0.12',
      'Switch on 10.0.0.13',
    ])
  })
})
