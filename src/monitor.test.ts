import type { ServiceType } from './interfaces.js'

import { EventEmitter } from 'node:events'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createConnection } from './eventedHttpClient/index.js'
import { HapMonitor } from './monitor.js'

// Mock the eventedHttpClient module
vi.mock('./eventedHttpClient/index.js', () => {
  const createMockSocket = () => {
    const socket = new EventEmitter() as any
    socket.destroy = vi.fn(() => {
      socket.destroyed = true
    })
    socket.removeAllListeners = vi.fn(() => {
      // Remove all listeners (do nothing in mock)
    })
    socket.write = vi.fn()
    socket.destroyed = false
    return socket
  }

  return {
    createConnection: vi.fn(() => createMockSocket()),
    parseMessage: vi.fn(() => ({ statusCode: 200, protocol: 'HTTP' })),
  }
})

function buildService(username: string): ServiceType {
  return {
    aid: 1,
    iid: 1,
    uuid: '00000001-0000-1000-8000-0026BB765291',
    type: 'Switch',
    humanType: 'Switch',
    serviceName: 'My Switch',
    serviceCharacteristics: [
      {
        aid: 1,
        iid: 2,
        uuid: '00000025-0000-1000-8000-0026BB765291',
        type: 'On',
        serviceType: 'Switch',
        serviceName: 'My Switch',
        description: 'On',
        value: false,
        format: 'bool',
        perms: ['pr', 'pw', 'ev'],
        canRead: true,
        canWrite: true,
        ev: true,
      },
    ],
    accessoryInformation: {},
    values: {},
    instance: {
      name: 'Test Bridge',
      username,
      ipAddress: '127.0.0.1',
      port: 51826,
      services: [],
      connectionFailedCount: 0,
      configurationNumber: 1,
    },
  }
}

describe('hapMonitor', () => {
  let monitor: HapMonitor
  const username = 'AA:BB:CC:DD:EE:FF'

  beforeEach(() => {
    vi.useFakeTimers()
    vi.clearAllMocks()
    const services = [buildService(username)]
    monitor = new HapMonitor(null, vi.fn(), '031-45-154', services)
  })

  afterEach(() => {
    monitor.finish()
    vi.useRealTimers()
  })

  it('should call createConnection on start', () => {
    expect(createConnection).toHaveBeenCalledTimes(1)
  })

  describe('isInstanceConnected', () => {
    it('should return true when socket is open', () => {
      expect(monitor.isInstanceConnected(username)).toBe(true)
    })

    it('should return false when socket is destroyed', () => {
      const socket = (monitor as any).evInstances[0].socket
      socket.destroyed = true
      expect(monitor.isInstanceConnected(username)).toBe(false)
    })

    it('should return false when socket is null', () => {
      (monitor as any).evInstances[0].socket = null
      expect(monitor.isInstanceConnected(username)).toBe(false)
    })

    it('should return false for unknown username', () => {
      expect(monitor.isInstanceConnected('unknown')).toBe(false)
    })
  })

  describe('socket close behavior', () => {
    it('should emit monitor-close when socket closes', () => {
      const events: string[] = []
      monitor.on('monitor-close', () => events.push('monitor-close'))

      const socket = (monitor as any).evInstances[0].socket
      socket.emit('close', false)

      expect(events).toEqual(['monitor-close'])
    })

    it('should not attempt operations after finish() is called', () => {
      const socket = (monitor as any).evInstances[0].socket

      monitor.finish()

      // Verify socket was destroyed
      expect(socket.destroy).toHaveBeenCalled()

      // createConnection called only once during initialization
      expect(createConnection).toHaveBeenCalledTimes(1)
    })
  })
})
