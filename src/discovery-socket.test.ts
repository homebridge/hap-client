import { describe, expect, it, vi } from 'vitest'

import { HapClient } from './index.js'

// This file uses the real bonjour-service (index.test.ts replaces it with a fake).
describe('hapClient mDNS socket errors', () => {
  it('logs an error of the mDNS socket instead of letting it crash the process', () => {
    const error = vi.fn()
    const client = new HapClient({
      pin: '123-45-678',
      logger: { error },
      config: { autoStartDiscovery: false },
    })

    try {
      // What multicast-dns does when port 5353 can not be bound. An 'error'
      // event without a listener is thrown by Node.
      const mdns = (client as any).bonjour.server.mdns
      expect(() => mdns.emit('error', new Error('bind EADDRINUSE 0.0.0.0:5353'))).not.toThrow()
      expect(error).toHaveBeenCalledWith('[HapClient] Discovery :: mDNS socket error: bind EADDRINUSE 0.0.0.0:5353')
    } finally {
      client.destroy()
    }
  })
})
