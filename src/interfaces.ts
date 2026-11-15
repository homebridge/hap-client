import { Buffer } from 'node:buffer'
import { Socket } from 'node:net'

/** A characteristic value as HAP sends it in JSON. `null` is a characteristic without a value. */
export type CharacteristicValue = number | string | boolean | null

export type CharacteristicFormat = 'bool' | 'int' | 'float' | 'string' | 'uint8' | 'uint16' | 'uint32' | 'uint64' | 'data' | 'tlv8' | 'array' | 'dictionary'
export type CharacteristicPerm = 'pr' | 'pw' | 'ev' | 'aa' | 'tw' | 'hd' | 'wr'
export type CharacteristicUnit = 'unit' | 'percentage' | 'celsius' | 'arcdegrees' | 'lux' | 'seconds'

/**
 * Where log lines go. Every method is optional: a level the logger does not
 * have is skipped. `console` and the Homebridge logger both fit.
 */
export interface HapClientLogger {
  debug?: (message: string) => void
  info?: (message: string) => void
  warn?: (message: string) => void
  error?: (message: string) => void
  log?: (message: string) => void
}

export interface HapInstance {
  name: string
  ipAddress: string | null
  port: number
  username: string
  connectionFailedCount: number
  services: ServiceType[]
  /** The `c#` of the bridge's mDNS record. mDNS text records are text, so this is a string such as `'12'`. */
  configurationNumber: string
}

export interface HapEvInstance {
  name: string
  ipAddress: string | null
  port: number
  username: string
  evCharacteristics?: { aid: number, iid: number, ev: boolean }[]
  socket?: Socket
  monitoring?: boolean
  recvBuffer?: Buffer
}

export interface HapAccessoriesRespType {
  accessories: Array<{
    /** Not part of the response: the client adds the bridge the accessory came from. */
    instance: HapInstance
    aid: number
    services: Array<{
      iid: number
      type: string
      primary: boolean
      hidden: boolean
      linked?: Array<number>
      characteristics: Array<{
        'iid': number
        'type': string
        'description': string
        /** Missing for a characteristic that can not be read */
        'value'?: CharacteristicValue
        'format': CharacteristicFormat
        'perms': Array<CharacteristicPerm>
        'unit'?: CharacteristicUnit
        'maxValue'?: number
        'minValue'?: number
        'minStep'?: number
        'maxLen'?: number
        'valid-values'?: number[]
        'valid-values-range'?: [min: number, max: number]
      }>
    }>
  }>
}

export interface HapCharacteristicRespType {
  characteristics: {
    aid: number
    iid: number
    value?: CharacteristicValue
    status?: number
  }[]
}

export interface ServiceType {
  aid: number
  iid: number
  uuid: string
  type: string
  linked?: Array<number>
  linkedServices?: {
    [iid: number]: ServiceType
  }
  hidden?: boolean
  humanType: string
  serviceName: string
  serviceCharacteristics: CharacteristicType[]
  /** The readable values of the accessory information service, by characteristic description (`Manufacturer`, `Serial Number`, ...) */
  accessoryInformation: AccessoryInformation
  /** Resolves with nothing when the bridge could not be reached (the error is logged) */
  refreshCharacteristics?: () => Promise<ServiceType | undefined>
  setCharacteristic?: (iid: number, value: number | string | boolean) => Promise<CharacteristicType | undefined>
  setCharacteristicByType?: (type: string, value: number | string | boolean) => Promise<CharacteristicType | undefined>
  setCharacteristicsByTypes?: (payload: Record<string, string | number | boolean>) => Promise<ServiceType | undefined>
  getCharacteristic?: (type: string) => CharacteristicType | undefined
  /** Only on a camera service. Resolves with the snapshot image. */
  getResource?: (body: ResourceRequestType) => Promise<Buffer | undefined>
  /** The last known value of each characteristic, by characteristic type (`On`, `Brightness`, ...) */
  values: Record<string, CharacteristicValue | undefined>
  instance: HapInstance
  uniqueId?: string
  /**
   * The unique id as it was built up to v5.4.0. Two services could share one,
   * so only use it to move data saved under the old id over to `uniqueId`.
   */
  legacyUniqueId?: string
  nameBasedUniqueId?: string
}

export interface CharacteristicType {
  /** Last HAP read status: zero indicates success; nonzero marks the cached value as unavailable. */
  status?: number
  aid: number
  iid: number
  uuid: string
  type: string
  serviceType: string
  serviceName: string
  description: string
  /** Missing for a characteristic that can not be read */
  value?: CharacteristicValue
  format: CharacteristicFormat
  perms: Array<CharacteristicPerm>
  unit?: CharacteristicUnit
  maxValue?: number
  minValue?: number
  minStep?: number
  validValues?: number[]
  canRead: boolean
  canWrite: boolean
  ev: boolean
  setValue?: (value: number | string | boolean) => Promise<CharacteristicType | undefined>
  /** Resolves with nothing when the bridge could not be reached (the error is logged) */
  getValue?: () => Promise<CharacteristicType | undefined>
}

/** The usual accessory information values, plus any other the accessory has. Each one can be missing. */
export type AccessoryInformation = Partial<AccessoryInformationProperties> & Record<string, CharacteristicValue | undefined>

export interface AccessoryInformationProperties {
  'Manufacturer': string
  'Model': string
  'Name': string
  'Serial Number': string
  'Firmware Revision': string
}

export interface ResourceRequestType {
  'aid'?: number
  'resource-type': string
  'image-width': number
  'image-height': number
}
