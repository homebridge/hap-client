import { Buffer } from 'node:buffer'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { createConnection } from './index.js'

const writeSpy = vi.fn()
const setKeepAliveSpy = vi.fn()

vi.mock('node:net', () => ({
  createConnection: vi.fn(() => ({
    write: writeSpy,
    setKeepAlive: setKeepAliveSpy,
    on: vi.fn(),
    destroy: vi.fn(),
    removeAllListeners: vi.fn(),
  })),
}))

describe('eventedHttpClient _buildMessage Content-Length', () => {
  afterEach(() => {
    writeSpy.mockClear()
  })

  // Assertion helpers must not call `expect` outside a test (test/no-standalone-expect);
  // they only extract values and the tests assert on them.
  function getWrittenMessage(): string {
    return writeSpy.mock.calls[0]?.[0]
  }

  function getDeclaredContentLength(message: string): number | null {
    const match = message.match(/Content-Length:\s*(\d+)/i)
    return match
      ? Number(match[1])
      : null
  }

  it('should declare Content-Length as the UTF-8 byte length, not the character count', () => {
    // Use a body whose serialised JSON contains a multibyte character so
    // byte length and character length differ.
    const bodyObj = {
      characteristics: [
        {
          aid: 1,
          iid: 2,
          ev: true,
          name: 'café',
        },
      ],
    }
    const serialised = JSON.stringify(bodyObj)

    createConnection({ ipAddress: '127.0.0.1', port: 51826 }, '031-45-154', bodyObj)

    expect(writeSpy).toHaveBeenCalledTimes(1)
    const declared = getDeclaredContentLength(getWrittenMessage())
    expect(declared).not.toBeNull()

    // 'café' is 4 chars but 5 bytes in UTF-8 (é = 0xC3 0xA9).
    expect(serialised.length).toBe(declared! - 1)
    expect(declared).toBe(Buffer.byteLength(serialised, 'utf8'))
  })

  it('should declare correct Content-Length for an ASCII-only body', () => {
    const bodyObj = {
      characteristics: [
        { aid: 1, iid: 2, ev: true },
      ],
    }
    const serialised = JSON.stringify(bodyObj)

    createConnection({ ipAddress: '127.0.0.1', port: 51826 }, '031-45-154', bodyObj)

    expect(writeSpy).toHaveBeenCalledTimes(1)
    const declared = getDeclaredContentLength(getWrittenMessage())
    expect(declared).toBe(Buffer.byteLength(serialised, 'utf8'))
    expect(declared).toBe(serialised.length) // all-ASCII so they match
  })
})

describe('eventedHttpClient connection', () => {
  afterEach(() => {
    writeSpy.mockClear()
    setKeepAliveSpy.mockClear()
  })

  // Without keep-alive a bridge whose machine lost power or network leaves the
  // socket open for ever: no close event, so no reconnect and no more events.
  it('turns on TCP keep-alive so a connection to a bridge that vanished gets closed', () => {
    createConnection({ ipAddress: '127.0.0.1', port: 51826 }, '031-45-154', { characteristics: [] })

    expect(setKeepAliveSpy).toHaveBeenCalledExactlyOnceWith(true, 30000)
  })
})
