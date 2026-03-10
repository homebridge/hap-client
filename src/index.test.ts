import { EventEmitter } from 'node:events'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { HapClient } from './index'

vi.mock('axios')

vi.mock('bonjour-service', () => ({
  default: class MockBonjour {
    stop = vi.fn()
    destroy = vi.fn()
    find = vi.fn().mockReturnValue({
      start: vi.fn(),
      stop: vi.fn(),
      on: vi.fn(),
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
