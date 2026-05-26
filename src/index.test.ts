import { EventEmitter } from 'node:events'

import axios from 'axios'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { Characteristics, Services } from './hap-types.js'
import { HapClient } from './index.js'

vi.mock('axios')

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

describe('hapClient bonjour up handler - same-port restart', () => {
  let hapClient: HapClient
  let upHandler: (device: any) => Promise<void>

  beforeEach(() => {
    hapClient = new HapClient({ pin: '123-45-678', config: { autoStartDiscovery: false } })
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
    hapClient = new HapClient({ pin: '123-45-678', config: { autoStartDiscovery: false, instanceBlacklist: ['ZZ:ZZ:ZZ:ZZ:ZZ:ZZ'] } })
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

describe('hapClient getAccessories - failing instance removal', () => {
  let hapClient: HapClient

  beforeEach(() => {
    hapClient = new HapClient({ pin: '123-45-678', config: { autoStartDiscovery: false } })
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
    ;(hapClient as any).instances = [failingInstance, healthyInstance]

    vi.mocked(axios.get).mockImplementation(async (url: string) => {
      if (url.includes('1.1.1.1')) {
        // Simulate the racing concurrent removal of the failing instance
        // before this catch handler reaches the splice.
        const idx = (hapClient as any).instances.indexOf(failingInstance)
        if (idx > -1) {
          (hapClient as any).instances.splice(idx, 1)
        }
        throw new Error('connection refused')
      }
      return { data: { accessories: [] } } as any
    })

    await (hapClient as any).getAccessories()

    // With the fix: findIndex returns -1, splice is skipped, healthy instance remains.
    // With the bug: splice(-1, 1) would have removed healthyInstance.
    expect((hapClient as any).instances).toContain(healthyInstance)
  })
})

describe('hapClient resetInstancePool - stale discovery timeout', () => {
  let hapClient: HapClient

  beforeEach(() => {
    vi.useFakeTimers()
    hapClient = new HapClient({ pin: '123-45-678', config: { autoStartDiscovery: false } })
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
    const refreshSpy = vi.spyOn(hapClient, 'refreshInstances').mockImplementation(() => {})

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
    ;(hapClient as any).browser = undefined

    expect(() => hapClient.resetInstancePool()).not.toThrow()
  })
})

describe('hapClient getAllServices - null Name characteristic value', () => {
  let hapClient: HapClient

  beforeEach(() => {
    hapClient = new HapClient({ pin: '123-45-678', config: { autoStartDiscovery: false } })
  })

  afterEach(() => {
    hapClient.destroy()
    vi.restoreAllMocks()
  })

  it('should not throw when an accessory exposes a Name characteristic with a null value', async () => {
    // Switch service UUID + Name characteristic UUID, both in long form.
    const switchUuid = Object.keys(Services).find(k => Services[k] === 'Switch')!
    const onUuid = Object.keys(Characteristics).find(k => Characteristics[k] === 'On')!

    const instance = {
      name: 'Test Bridge',
      username: 'AA:BB:CC:DD:EE:FF',
      ipAddress: '127.0.0.1',
      port: 51826,
      services: [],
      connectionFailedCount: 0,
      configurationNumber: 1,
    }
    ;(hapClient as any).instances = [instance]

    vi.mocked(axios.get).mockResolvedValue({
      data: {
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
      },
    } as any)

    // getAllServices() must resolve (not reject) when a Name characteristic
    // has a null value; awaiting it directly fails the test if it throws.
    const services = await hapClient.getAllServices()

    // Should fall back to the humanised service name.
    expect(services).toHaveLength(1)
    expect(services[0].serviceName).toBe('Switch')
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
    hapClient = new HapClient({ pin: '123-45-678', config: { autoStartDiscovery: false } })
  })

  afterEach(() => {
    hapClient.destroy()
    vi.restoreAllMocks()
  })

  it('should skip response characteristics whose iid is not in the service', async () => {
    const service = buildService() as any

    vi.mocked(axios.get).mockResolvedValue({
      data: {
        characteristics: [
          // iid 99 is not in the service — without the guard `characteristic.value = c.value` throws.
          { aid: 1, iid: 99, value: false },
        ],
      },
    } as any)

    await expect(hapClient.refreshServiceCharacteristics(service)).resolves.toBe(service)

    // Cached value untouched because the only response entry was a stale iid.
    expect(service.serviceCharacteristics[0].value).toBe(true)
    expect(service.values.On).toBe(true)
  })

  it('should preserve cached value when HAP returns a value-less entry (status error)', async () => {
    const service = buildService() as any

    vi.mocked(axios.get).mockResolvedValue({
      data: {
        // HAP returns `{ aid, iid, status }` with no `value` field on per-char errors.
        // Without the guard `characteristic.value = c.value` overwrites `true` with `undefined`.
        characteristics: [
          { aid: 1, iid: 10, status: -70402 },
        ],
      },
    } as any)

    await hapClient.refreshServiceCharacteristics(service)

    expect(service.serviceCharacteristics[0].value).toBe(true)
    expect(service.values.On).toBe(true)
  })

  it('getCharacteristic should not log an error on an empty characteristics response', async () => {
    const service = buildService() as any

    // Build a client with a logger spy so we can assert nothing was logged as error.
    const errorSpy = vi.fn()
    const localClient = new HapClient({
      pin: '123-45-678',
      logger: { error: errorSpy, warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
      config: { autoStartDiscovery: false },
    })

    vi.mocked(axios.get).mockResolvedValue({
      data: { characteristics: [] },
    } as any)

    // Without the guard `resp.characteristics[0].iid` throws a TypeError that
    // the try/catch swallows — but the misleading "Failed to get characteristic"
    // error log is still emitted, polluting the user's logs.
    const result = await localClient.getCharacteristic(service, 10)
    expect(result).toBeUndefined()
    expect(errorSpy).not.toHaveBeenCalled()
    expect(service.serviceCharacteristics[0].value).toBe(true)

    localClient.destroy()
  })

  it('getCharacteristic should preserve cached value when response entry has no value', async () => {
    const service = buildService() as any

    vi.mocked(axios.get).mockResolvedValue({
      data: { characteristics: [{ aid: 1, iid: 10, status: -70402 }] },
    } as any)

    await hapClient.getCharacteristic(service, 10)

    expect(service.serviceCharacteristics[0].value).toBe(true)
    expect(service.values.On).toBe(true)
  })

  it('refreshInstances should log when browser.update() throws instead of swallowing the error', () => {
    const debugSpy = vi.fn()
    const localClient = new HapClient({
      pin: '123-45-678',
      logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), log: vi.fn(), debug: debugSpy },
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

  it('setCharacteristicsByTypes should not send an empty PUT when only Configured Name is in the payload', async () => {
    // Service with both an "On" characteristic and a "Configured Name" characteristic.
    const service = buildService() as any
    service.serviceCharacteristics.push({
      aid: 1,
      iid: 11,
      uuid: '000000E3-0000-1000-8000-0026BB765291',
      type: 'Configured Name',
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

    const putSpy = vi.mocked(axios.put).mockResolvedValue({ data: {} } as any)
    vi.mocked(axios.get).mockResolvedValue({ data: { characteristics: [] } } as any)

    await hapClient.setCharacteristicsByTypes(service, { 'Configured Name': 'Bar' })

    // Without the guard the function called setCharacteristics with `[]`,
    // which sends `PUT /characteristics { characteristics: [] }` to HAP.
    expect(putSpy).not.toHaveBeenCalled()
  })
})

describe('hapClient monitorCharacteristics - replacing existing monitor', () => {
  let hapClient: HapClient

  beforeEach(() => {
    hapClient = new HapClient({ pin: '123-45-678', config: { autoStartDiscovery: false } })
  })

  afterEach(() => {
    hapClient.destroy()
  })

  it('should call finish() on the previous monitor before replacing it', async () => {
    const previousFinish = vi.fn()
    ;(hapClient as any).hapMonitor = { finish: previousFinish }

    // Pass an empty services array so HapMonitor construction doesn't try to open sockets.
    await hapClient.monitorCharacteristics([])

    // Without the fix the previous monitor was overwritten without finish(),
    // leaking all of its open sockets.
    expect(previousFinish).toHaveBeenCalledTimes(1)
  })
})
