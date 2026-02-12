import { EventEmitter } from 'node:events'

import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals'

import { HapClient } from './index'

jest.mock('axios')

jest.mock('bonjour-service', () => {
  return jest.fn().mockImplementation(() => ({
    stop: jest.fn(),
    destroy: jest.fn(),
    find: jest.fn().mockReturnValue({
      start: jest.fn(),
      stop: jest.fn(),
      on: jest.fn(),
    }),
  }))
})

describe('hapClient', () => {
  let hapClient

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
