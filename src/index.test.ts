import { EventEmitter } from 'node:events'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { HapClient } from './index.js'

vi.mock('axios')

let mockBrowserOn: ReturnType<typeof vi.fn>

vi.mock('bonjour-service', () => ({
  Bonjour: class MockBonjour {
    stop = vi.fn()
    destroy = vi.fn()
    find = vi.fn().mockImplementation(() => {
      mockBrowserOn = vi.fn()
      return {
        start: vi.fn(),
        stop: vi.fn(),
        on: mockBrowserOn,
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
    ;(hapClient as any).hapMonitor = {
      isInstanceConnected: vi.fn().mockReturnValue(false),
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
    ;(hapClient as any).hapMonitor = {
      isInstanceConnected: vi.fn().mockReturnValue(true),
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
