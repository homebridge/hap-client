import type { ServiceType } from './interfaces.js'

import { Buffer } from 'node:buffer'
import { EventEmitter } from 'node:events'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import realHttpParser from './eventedHttpClient/httpParser.js'
import { createConnection, parseMessage } from './eventedHttpClient/index.js'
import { findMessageBoundary, HapMonitor } from './monitor.js'

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

  describe('error logging', () => {
    it('should call logger.error rather than logger.log when error() is invoked', () => {
      const logSpy = vi.fn()
      const errorSpy = vi.fn()
      const services = [buildService('CC:CC:CC:CC:CC:CC')]
      const m = new HapMonitor({ log: logSpy, error: errorSpy }, vi.fn(), '031-45-154', services)

      m.error('boom')

      // Without the fix the message went through `logger.log` with a manual
      // "ERROR:" prefix, so anything filtering by log level missed it.
      expect(errorSpy).toHaveBeenCalledWith('[HapMonitor] boom')
      expect(logSpy).not.toHaveBeenCalled()

      m.finish()
    })
  })

  describe('refreshMonitorConnection', () => {
    it('should not throw when the instance has no socket assigned', () => {
      // Reproduces the state where connectInstance previously failed inside its
      // try/catch and never assigned instance.socket.
      const instance = (monitor as any).evInstances[0]
      instance.socket = undefined

      expect(() => monitor.refreshMonitorConnection({
        ...instance,
        port: 51827,
        ipAddress: '127.0.0.2',
      })).not.toThrow()
    })
  })
})

describe('findMessageBoundary', () => {
  function build(body: string, headers: Record<string, string> = {}): Buffer {
    const headerLines = ['EVENT/1.0 200 OK', 'Content-Type: application/hap+json', `Content-Length: ${Buffer.byteLength(body, 'utf8')}`]
    for (const [k, v] of Object.entries(headers)) {
      headerLines.push(`${k}: ${v}`)
    }
    return Buffer.from(`${headerLines.join('\r\n')}\r\n\r\n${body}`, 'utf8')
  }

  it('returns -1 for an empty buffer', () => {
    expect(findMessageBoundary(Buffer.alloc(0))).toBe(-1)
  })

  it('returns -1 when headers are not yet terminated', () => {
    expect(findMessageBoundary(Buffer.from('EVENT/1.0 200 OK\r\nContent-Length: 5'))).toBe(-1)
  })

  it('returns the message length when one complete message is buffered', () => {
    const msg = build('{"a":1}')
    expect(findMessageBoundary(msg)).toBe(msg.length)
  })

  it('returns the FIRST message length when two complete messages are buffered', () => {
    const first = build('{"a":1}')
    const second = build('{"b":2}')
    const combined = Buffer.concat([first, second])

    const boundary = findMessageBoundary(combined)
    expect(boundary).toBe(first.length)
    // The remainder is the start of the second message.
    expect(combined.subarray(boundary).equals(second)).toBe(true)
  })

  it('uses byte length, not character count, for multibyte UTF-8 bodies', () => {
    // The € sign is 3 bytes in UTF-8 but a single string character. A
    // string-index implementation would compute the boundary 2 positions short
    // and slice into the next message (or wait forever for bytes it already has).
    const first = build('{"name":"€ store"}')
    const second = build('{"a":1}')
    const combined = Buffer.concat([first, second])

    const boundary = findMessageBoundary(combined)
    expect(boundary).toBe(first.length)
    expect(combined.subarray(boundary).equals(second)).toBe(true)
  })

  it('ends a bodyless (no Content-Length) message at the header terminator, not the buffer end', () => {
    // A subscribe ACK is a 204 with no body and no Content-Length. It can be
    // coalesced into the same TCP chunk as the first EVENT; returning the whole
    // buffer here would swallow that EVENT.
    const ack = 'HTTP/1.1 204 No Content\r\nConnection: keep-alive\r\n\r\n'
    const event = build('{"characteristics":[{"aid":1,"iid":2,"value":true}]}')
    const combined = Buffer.concat([Buffer.from(ack, 'utf8'), event])

    const boundary = findMessageBoundary(combined)
    expect(boundary).toBe(Buffer.byteLength(ack, 'utf8'))
    expect(combined.subarray(boundary).equals(event)).toBe(true)
  })

  it('returns -1 when the body is shorter than Content-Length', () => {
    const fullBody = '{"characteristics":[{"aid":1,"iid":10,"value":true}]}'
    const headers = `EVENT/1.0 200 OK\r\nContent-Type: application/hap+json\r\nContent-Length: ${fullBody.length}\r\n\r\n`
    const truncated = Buffer.from(headers + fullBody.slice(0, fullBody.length - 5), 'utf8')

    expect(findMessageBoundary(truncated)).toBe(-1)
  })
})

describe('hapMonitor data handling - multiple messages per chunk', () => {
  let monitor: HapMonitor
  const username = 'AA:BB:CC:DD:EE:FF'

  beforeEach(() => {
    vi.clearAllMocks()
    // Use the real HTTP parser for this scenario so we can assert how the
    // monitor splits and dispatches multi-message TCP chunks.
    vi.mocked(parseMessage).mockImplementation((msg: any) => realHttpParser(msg))

    const services = [buildService(username)]
    monitor = new HapMonitor(null, vi.fn(), '031-45-154', services)
  })

  afterEach(() => {
    monitor.finish()
    vi.mocked(parseMessage).mockReset()
    vi.mocked(parseMessage).mockImplementation(() => ({ statusCode: 200, protocol: 'HTTP' } as any))
  })

  function buildEvent(value: boolean): string {
    const body = JSON.stringify({ characteristics: [{ aid: 1, iid: 2, value }] })
    return [
      'EVENT/1.0 200 OK',
      'Content-Type: application/hap+json',
      `Content-Length: ${Buffer.byteLength(body, 'utf8')}`,
      '',
      body,
    ].join('\r\n')
  }

  it('should emit service-update for every message in a single TCP chunk', () => {
    const updates: any[][] = []
    monitor.on('service-update', services => updates.push(services))

    const socket = (monitor as any).evInstances[0].socket
    const combined = buildEvent(true) + buildEvent(false) + buildEvent(true)

    socket.emit('data', Buffer.from(combined, 'utf8'))

    // Without the fix only the first message was parsed and emitted; the
    // second and third silently fell off the floor.
    expect(updates).toHaveLength(3)
  })

  it('should not drop an EVENT coalesced behind a bodyless ACK in the same chunk', () => {
    const updates: any[][] = []
    monitor.on('service-update', services => updates.push(services))

    const socket = (monitor as any).evInstances[0].socket
    // The subscribe ACK (204, no body, no Content-Length) arrives in the same
    // TCP chunk as the first EVENT. The ACK must not consume the EVENT.
    const ack = 'HTTP/1.1 204 No Content\r\nConnection: keep-alive\r\n\r\n'
    socket.emit('data', Buffer.from(ack + buildEvent(true), 'utf8'))

    expect(updates).toHaveLength(1)
  })

  it('should buffer a message split across two data events and emit once when complete', () => {
    const updates: any[][] = []
    monitor.on('service-update', services => updates.push(services))

    const socket = (monitor as any).evInstances[0].socket
    const full = buildEvent(true)
    const splitAt = Math.floor(full.length / 2)

    socket.emit('data', Buffer.from(full.slice(0, splitAt), 'utf8'))
    expect(updates).toHaveLength(0) // not enough data yet

    socket.emit('data', Buffer.from(full.slice(splitAt), 'utf8'))
    expect(updates).toHaveLength(1)
  })

  it('resets the connection when the receive buffer grows past the cap without a complete message', () => {
    const socket = (monitor as any).evInstances[0].socket
    // No header terminator, so findMessageBoundary never completes and the
    // buffer would otherwise grow forever. 2 MB + 1 byte trips the cap.
    const garbage = Buffer.alloc(2 * 1024 * 1024 + 1, 0x61)

    socket.emit('data', garbage)

    expect(socket.destroy).toHaveBeenCalled()
    expect((monitor as any).evInstances[0].recvBuffer.length).toBe(0)
  })
})
