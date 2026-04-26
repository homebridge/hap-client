import { EventEmitter } from 'node:events'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { HapMonitor } from './monitor.js'
import type { HapEvInstance, ServiceType } from './interfaces.js'

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

import { createConnection } from './eventedHttpClient/index.js'

const buildService = (username: string): ServiceType => ({
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
})

describe('HapMonitor', () => {
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

  describe('auto-reconnect on socket close', () => {
    it('should schedule a reconnect when socket closes and monitor is not stopped', () => {
      const refreshSpy = vi.spyOn(monitor, 'emit')
      const socket = (monitor as any).evInstances[0].socket

      // Simulate socket close
      socket.emit('close', false)

      expect(refreshSpy).toHaveBeenCalledWith('monitor-close', expect.anything(), false)

      // Advance timers to trigger reconnect
      vi.advanceTimersByTime(5000)

      expect(createConnection).toHaveBeenCalledTimes(2)
      expect(refreshSpy).toHaveBeenCalledWith('monitor-refresh', expect.anything())
    })

    it('should emit monitor-refresh when reconnect fires', () => {
      const events: string[] = []
      monitor.on('monitor-refresh', () => events.push('monitor-refresh'))
      monitor.on('monitor-close', () => events.push('monitor-close'))

      const socket = (monitor as any).evInstances[0].socket
      socket.emit('close', false)

      expect(events).toEqual(['monitor-close'])

      vi.advanceTimersByTime(5000)

      expect(events).toContain('monitor-refresh')
    })

    it('should not reconnect when monitor is stopped via finish()', () => {
      const socket = (monitor as any).evInstances[0].socket

      // Stop the monitor first, then close the socket
      monitor.finish()
      socket.emit('close', false)

      vi.advanceTimersByTime(60000)

      // createConnection called only once during start
      expect(createConnection).toHaveBeenCalledTimes(1)
    })

    it('should not reconnect after finish() is called while reconnect is pending', () => {
      const socket = (monitor as any).evInstances[0].socket
      socket.emit('close', false)

      // Stop before timer fires
      monitor.finish()

      vi.advanceTimersByTime(60000)

      expect(createConnection).toHaveBeenCalledTimes(1)
    })

    it('should use exponential backoff for reconnect delays', () => {
      const socket = (monitor as any).evInstances[0].socket
      socket.emit('close', false)

      // First reconnect at ~2s
      vi.advanceTimersByTime(3100)
      expect(createConnection).toHaveBeenCalledTimes(2)

      // Simulate close again - next delay should be ~4s
      const socket2 = (monitor as any).evInstances[0].socket
      socket2.emit('close', false)

      // Should not reconnect before 4s
      vi.advanceTimersByTime(3000)
      expect(createConnection).toHaveBeenCalledTimes(2)

      // Should reconnect after 4s + jitter (max 1s)
      vi.advanceTimersByTime(2000)
      expect(createConnection).toHaveBeenCalledTimes(3)
    })
  })

  describe('refreshMonitorConnection', () => {
    it('should cancel a pending reconnect timer before reconnecting', () => {
      const socket = (monitor as any).evInstances[0].socket
      socket.emit('close', false)

      // There should be a pending timer
      expect((monitor as any)._reconnectTimers.size).toBe(1)

      // Manually trigger refresh before timer fires
      const refreshInstance: HapEvInstance = {
        name: 'Test Bridge',
        username,
        ipAddress: '127.0.0.1',
        port: 51826,
      }
      monitor.refreshMonitorConnection(refreshInstance)

      // Timer should be cancelled
      expect((monitor as any)._reconnectTimers.size).toBe(0)

      // Advance past original timer - should not fire again
      vi.advanceTimersByTime(5000)
      // 1 initial + 1 from refreshMonitorConnection = 2
      expect(createConnection).toHaveBeenCalledTimes(2)
    })

    it('should reset reconnect delay when refreshMonitorConnection is called', () => {
      const socket = (monitor as any).evInstances[0].socket
      socket.emit('close', false)

      // Simulate a few failures to build up delay
      vi.advanceTimersByTime(3100)
      const socket2 = (monitor as any).evInstances[0].socket
      socket2.emit('close', false)
      vi.advanceTimersByTime(5100)

      // Delay should be higher now
      expect((monitor as any)._reconnectDelays.get(username)).toBeGreaterThan(2000)

      // Call refreshMonitorConnection - should reset delay
      monitor.refreshMonitorConnection({
        name: 'Test Bridge',
        username,
        ipAddress: '127.0.0.1',
        port: 51826,
      })

      expect((monitor as any)._reconnectDelays.has(username)).toBe(false)
    })

    it('should handle null socket gracefully', () => {
      (monitor as any).evInstances[0].socket = null

      expect(() => {
        monitor.refreshMonitorConnection({
          name: 'Test Bridge',
          username,
          ipAddress: '127.0.0.1',
          port: 51826,
        })
      }).not.toThrow()
    })
  })

  describe('finish', () => {
    it('should set _stopped to true', () => {
      monitor.finish()
      expect((monitor as any)._stopped).toBe(true)
    })

    it('should clear reconnect timers', () => {
      const socket = (monitor as any).evInstances[0].socket
      socket.emit('close', false)

      expect((monitor as any)._reconnectTimers.size).toBe(1)

      monitor.finish()

      expect((monitor as any)._reconnectTimers.size).toBe(0)
    })

    it('should clear reconnect delays', () => {
      const socket = (monitor as any).evInstances[0].socket
      socket.emit('close', false)
      vi.advanceTimersByTime(3100)

      const socket2 = (monitor as any).evInstances[0].socket
      socket2.emit('close', false)

      expect((monitor as any)._reconnectDelays.size).toBeGreaterThan(0)

      monitor.finish()

      expect((monitor as any)._reconnectDelays.size).toBe(0)
    })
  })
})
