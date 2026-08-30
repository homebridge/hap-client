import { describe, expect, it } from 'vitest'

import { PluginCharacteristics, PluginServices } from '../scripts/plugin-types.js'
import { Categories, Characteristics, Enums, Services } from './hap-types.js'

const UUID_REGEX = /^[0-9A-F]{8}-[0-9A-F]{4}-[1-5][0-9A-F]{3}-[89AB][0-9A-F]{3}-[0-9A-F]{12}$/

describe('services', () => {
  it('should be exported', () => {
    expect(Services).toBeDefined()
  })

  it('should have symmetric mappings for UUID keys', () => {
    Object.entries(Services)
      .filter(([key]) => UUID_REGEX.test(key))
      .forEach(([, value]) => {
        expect(typeof value).toBe('string')
      })
    Object.entries(Services)
      .filter(([key]) => !UUID_REGEX.test(key))
      .forEach(([, value]) => {
        expect(UUID_REGEX.test(value)).toBe(true)
        expect(Services[value]).toBeDefined()
      })
  })

  it('00000113-0000-1000-8000-0026BB765291 should be Speaker', () => {
    expect(Services['00000113-0000-1000-8000-0026BB765291']).toBe('Speaker')
  })

  it('should include custom homebridge-lib services', () => {
    expect(Services.History).toBe('E863F007-079E-48FF-8F27-9C2605A29F52')
  })

  it('length should be 145 or greater', () => {
    expect(Object.keys(Services).length).toBeGreaterThanOrEqual(145)
  })
})

describe('characteristics', () => {
  it('should be exported', () => {
    expect(Characteristics).toBeDefined()
  })

  it('should have symmetric mappings for UUID keys', () => {
    Object.entries(Characteristics)
      .filter(([key]) => UUID_REGEX.test(key))
      .forEach(([, value]) => {
        expect(typeof value).toBe('string')
      })
    Object.entries(Characteristics)
      .filter(([key]) => !UUID_REGEX.test(key))
      .forEach(([, value]) => {
        expect(UUID_REGEX.test(value)).toBe(true)
        expect(Characteristics[value]).toBeDefined()
      })
  })

  it('should include custom homebridge-lib characteristics', () => {
    expect(Characteristics.VOCLevel).toBe('E863F10B-079E-48FF-8F27-9C2605A29F52')
  })

  it('should include plugin-defined characteristics', () => {
    expect(Characteristics.OpticalSignal).toBe('A11C14A7-BB9B-4085-8597-68CF63964BF8')
  })

  it('length should be 488 or greater', () => {
    expect(Object.keys(Characteristics).length).toBeGreaterThanOrEqual(488)
  })
})

/**
 * Every entry in scripts/plugin-types.ts must be present in the generated
 * maps, in both directions. This is what catches an entry added to the
 * registry without `npm run gen` being run afterwards.
 */
describe('plugin type registry', () => {
  it('every registered plugin service is in the generated maps', () => {
    PluginServices.forEach(({ name, uuid }) => {
      expect(Services[name]).toBe(uuid.toUpperCase())
      expect(Services[uuid.toUpperCase()]).toBe(name)
    })
  })

  it('every registered plugin characteristic is in the generated maps', () => {
    PluginCharacteristics.forEach(({ name, uuid }) => {
      expect(Characteristics[name]).toBe(uuid.toUpperCase())
      expect(Characteristics[uuid.toUpperCase()]).toBe(name)
    })
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
