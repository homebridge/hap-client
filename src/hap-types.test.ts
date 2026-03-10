import { describe, expect, it } from 'vitest'

import { Categories, Characteristics, Enums, Services } from './hap-types.js'

describe('services', () => {
  it('should be exported', () => {
    expect(Services).toBeDefined()
  })
  it('should have symmetric mappings for all keys except TelevisionSpeaker', () => {
    Object.keys(Services).forEach((key) => {
      const value = Services[key]
      if (key !== 'TelevisionSpeaker') {
        expect(Services[value]).toBe(key)
      }
    })
  })
  it('00000113-0000-1000-8000-0026BB765291 should be Speaker', () => {
    expect(Services['00000113-0000-1000-8000-0026BB765291']).toBe('Speaker')
  })
  it('length should be 145 or greater', () => {
    expect(Object.keys(Services).length).toBeGreaterThanOrEqual(145)
  })
})

describe('characteristics', () => {
  it('should be exported', () => {
    expect(Characteristics).toBeDefined()
  })
  it('should have symmetric mappings for all keys', () => {
    Object.keys(Characteristics).forEach((key) => {
      const value = Characteristics[key]
      expect(Characteristics[value]).toBe(key)
    })
  })
  it('length should be 488 or greater', () => {
    expect(Object.keys(Characteristics).length).toBeGreaterThanOrEqual(488)
  })
})

describe('categories', () => {
  it('should be exported', () => {
    expect(Categories).toBeDefined()
  })
  it('length should be 38 or greater', () => {
    expect(Object.keys(Categories).length).toBeGreaterThanOrEqual(38)
  })
})

describe('enums', () => {
  it('should be exported', () => {
    expect(Enums).toBeDefined()
  })
})
