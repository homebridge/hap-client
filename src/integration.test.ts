import type { HapInstance, ServiceType } from './interfaces.js'

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { Accessory, AccessoryEventTypes, Bridge, Categories, Characteristic, HAPStatus, HapStatusError, HAPStorage, Service, uuid } from '@homebridge/hap-nodejs'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

import { HapClient } from './index.js'

// Nothing is faked in this file: a real HAP-NodeJS bridge in insecure mode, on
// 127.0.0.1 only, and the real client talking to it over real sockets. It is
// here to notice when the two stop understanding each other.
describe('hapClient against a real HAP-NodeJS bridge', () => {
  const PIN = '031-45-154'
  const USERNAME = 'AA:BB:CC:DD:EE:01'
  const logger = {
    error: vi.fn(),
    warn: vi.fn(),
  }

  let storagePath: string
  let bridge: Bridge
  let lamp: Service
  let client: HapClient
  let instance: HapInstance
  let services: ServiceType[]

  let lampOn = false
  let remoteKey: unknown

  const service = (type: string) => services.find(x => x.type === type)!

  beforeAll(async () => {
    storagePath = mkdtempSync(join(tmpdir(), 'hap-client-test-'))
    HAPStorage.setCustomStoragePath(storagePath)

    bridge = new Bridge('Test Bridge', uuid.generate('hap-client-test-bridge'))

    const lampAccessory = new Accessory('Lamp', uuid.generate('hap-client-test-lamp'))
    lamp = lampAccessory.addService(Service.Lightbulb, 'Lamp')
    lamp.getCharacteristic(Characteristic.On)
      .onGet(() => lampOn)
      .onSet((value) => {
        lampOn = value as boolean
      })
    // A characteristic whose plugin fails every write (reads work)
    lamp.getCharacteristic(Characteristic.Brightness)
      .onGet(() => 10)
      .onSet(() => {
        throw new HapStatusError(HAPStatus.SERVICE_COMMUNICATION_FAILURE)
      })
    // A characteristic whose plugin fails every read
    lamp.getCharacteristic(Characteristic.Hue)
      .onGet(() => {
        throw new HapStatusError(HAPStatus.SERVICE_COMMUNICATION_FAILURE)
      })
    bridge.addBridgedAccessory(lampAccessory)

    const tvAccessory = new Accessory('TV', uuid.generate('hap-client-test-tv'))
    const tv = tvAccessory.addService(Service.Television, 'TV')
    // RemoteKey can be written but not read
    tv.getCharacteristic(Characteristic.RemoteKey).onSet((value) => {
      remoteKey = value
    })
    bridge.addBridgedAccessory(tvAccessory)

    const listening = new Promise<number>((resolve) => {
      bridge.once(AccessoryEventTypes.LISTENING, port => resolve(port))
    })
    await bridge.publish({
      username: USERNAME,
      pincode: PIN,
      port: 0,
      category: Categories.BRIDGE,
      bind: ['127.0.0.1'],
    }, true)

    instance = {
      name: 'homebridge',
      displayName: 'homebridge',
      username: USERNAME,
      ipAddress: '127.0.0.1',
      port: await listening,
      services: [],
      connectionFailedCount: 0,
      configurationNumber: '1',
    }

    // Discovery is left out: the bridge is handed to the client directly, so
    // the test does not depend on mDNS working on the machine.
    client = new HapClient({
      pin: PIN,
      logger,
      config: { autoStartDiscovery: false },
    })
    ;(client as any).instances.push(instance)
    services = await client.getAllServices()
  })

  afterAll(async () => {
    client?.destroy()
    await bridge?.unpublish()
    rmSync(storagePath, { recursive: true, force: true })
  })

  it('reads the services and their characteristics', () => {
    expect(services.map(x => `${x.serviceName}: ${x.type}`)).toEqual(expect.arrayContaining(['Lamp: Lightbulb', 'TV: Television']))

    const on = service('Lightbulb').getCharacteristic!('On')!
    expect(on).toMatchObject({
      canRead: true,
      canWrite: true,
      ev: true,
      format: 'bool',
    })
    expect(service('Television').getCharacteristic!('RemoteKey')).toMatchObject({ canRead: false, canWrite: true })
    expect(service('Lightbulb').accessoryInformation.Name).toBe('Lamp')
  })

  it('is accepted with the right pin and refused with a wrong one', async () => {
    await expect((client as any).checkInstanceConnection(instance)).resolves.toBe(true)

    const warn = vi.fn()
    const stranger = new HapClient({
      pin: '000-00-000',
      logger: { warn },
      config: { autoStartDiscovery: false },
    })
    try {
      await expect((stranger as any).checkInstanceConnection({ ...instance })).resolves.toBe(false)
      expect(warn).toHaveBeenCalledExactlyOnceWith(expect.stringContaining('refused the pin'))
    } finally {
      stranger.destroy()
    }
  })

  it('writes a value and reads it back', async () => {
    const result = await service('Lightbulb').setCharacteristicByType!('On', true)

    expect(lampOn).toBe(true)
    // HAP-NodeJS sends a boolean as 1 or 0
    expect(result?.value).toBe(1)
    expect(service('Lightbulb').values.On).toBe(1)
  })

  it('writes a characteristic which can not be read', async () => {
    await expect(service('Television').setCharacteristicByType!('RemoteKey', 4)).resolves.toMatchObject({ type: 'RemoteKey' })

    expect(remoteKey).toBe(4)
  })

  it('rejects a write the plugin refused', async () => {
    await expect(service('Lightbulb').setCharacteristicByType!('Brightness', 50)).rejects.toMatchObject({
      name: 'HapCharacteristicError',
      message: expect.stringContaining(`returned HAP status ${HAPStatus.SERVICE_COMMUNICATION_FAILURE}`),
    })
  })

  it('rejects a read the plugin failed and records the status', async () => {
    const hue = service('Lightbulb').getCharacteristic!('Hue')!

    await expect(hue.getValue!()).rejects.toMatchObject({ name: 'HapCharacteristicError' })
    expect(hue.status).toBe(HAPStatus.SERVICE_COMMUNICATION_FAILURE)
  })

  it('refuses a write with a wrong pin and names the pin', async () => {
    const stranger = new HapClient({
      pin: '000-00-000',
      logger: {},
      config: { autoStartDiscovery: false },
    })
    try {
      await expect(stranger.setCharacteristic(service('Lightbulb'), service('Lightbulb').getCharacteristic!('On')!.iid, false))
        .rejects
        .toThrow('Make sure the Homebridge pin for')
      expect(lampOn).toBe(true)
    } finally {
      stranger.destroy()
    }
  })

  it('reports a change of a value through the monitor', async () => {
    const monitor = await client.monitorCharacteristics(services)
    const updates: ServiceType[][] = []
    monitor.on('service-update', updated => updates.push(updated))
    // The bridge only sends events once it has handled the subscription, and
    // only for a value that changed: keep changing it until an event arrives.
    await vi.waitFor(() => {
      lampOn = !lampOn
      lamp.updateCharacteristic(Characteristic.On, lampOn)
      expect(updates.length).toBeGreaterThan(0)
    }, { timeout: 5000, interval: 100 })

    expect(updates[0].map(x => x.serviceName)).toEqual(['Lamp'])
    // HAP-NodeJS sends a boolean as 1 or 0
    expect([0, 1]).toContain(updates[0][0].values.On)
  })
})
