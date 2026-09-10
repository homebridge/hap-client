import { Buffer } from 'node:buffer'
import { Socket } from 'node:net'

export interface HapInstance {
  name: string
  ipAddress: string | null
  port: number
  username: string
  connectionFailedCount: number
  services: ServiceType[]
  configurationNumber: number
  /**
   * Whether this instance has already been told off for refusing the pin.
   *
   * Discovery re-probes every instance on a timer, so without this the warning
   * repeats for as long as the mismatch lasts. That is fine for a bridge whose
   * pin the user can correct, and endless for a second Homebridge install on
   * the same network, whose pin is not theirs to change (#2979). Cleared on the
   * next successful connection, so a mismatch that returns is reported again.
   */
  pinRefusalLogged?: boolean
}

export interface HapEvInstance {
  name: string
  ipAddress: string
  port: number
  username: string
  evCharacteristics?: { aid: number, iid: number, ev: boolean }[]
  socket?: Socket
  monitoring?: boolean
  recvBuffer?: Buffer
}

export interface HapAccessoriesRespType {
  accessories: Array<{
    instance: HapInstance
    aid: number
    services: Array<{
      iid: number
      type: string
      primary: boolean
      hidden: boolean
      linked?: Array<number>
      characteristics: Array<{
        iid: number
        type: string
        description: string
        value: number | string | boolean
        format: 'bool' | 'int' | 'float' | 'string' | 'uint8' | 'uint16' | 'uint32' | 'uint64' | 'data' | 'tlv8' | 'array' | 'dictionary'
        perms: Array<'pr' | 'pw' | 'ev' | 'aa' | 'tw' | 'hd'>
        unit?: 'unit' | 'percentage' | 'celsius' | 'arcdegrees' | 'lux' | 'seconds'
        maxValue?: number
        minValue?: number
        minStep?: number
        validValues?: (number | string | boolean)[]
      }>
    }>
  }>
}

export interface HapCharacteristicRespType {
  characteristics: {
    aid: number
    iid: number
    value?: number | string | boolean
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
  accessoryInformation: any
  refreshCharacteristics?: () => Promise<ServiceType>
  setCharacteristic?: (iid: number, value: number | string | boolean) => Promise<ServiceType>
  setCharacteristicByType?: (type: string, value: number | string | boolean) => Promise<ServiceType>
  setCharacteristicsByTypes?: (payload: Record<string, string | number | boolean>) => Promise<ServiceType>
  getCharacteristic?: (type: string) => CharacteristicType
  getResource?: (body: ResourceRequestType) => Promise<ServiceType>
  values: any
  instance: HapInstance
  uniqueId?: string
  nameBasedUniqueId?: string
}

export interface CharacteristicType {
  aid: number
  iid: number
  uuid: string
  type: string
  serviceType: string
  serviceName: string
  description: string
  value: number | string | boolean
  format: 'bool' | 'int' | 'float' | 'string' | 'uint8' | 'uint16' | 'uint32' | 'uint64' | 'data' | 'tlv8' | 'array' | 'dictionary'
  perms: Array<'pr' | 'pw' | 'ev' | 'aa' | 'tw' | 'hd'>
  unit?: 'unit' | 'percentage' | 'celsius' | 'arcdegrees' | 'lux' | 'seconds'
  maxValue?: number
  minValue?: number
  minStep?: number
  validValues?: (number | string | boolean)[]
  canRead: boolean
  canWrite: boolean
  ev: boolean
  setValue?: (value: number | string | boolean) => Promise<CharacteristicType>
  getValue?: () => Promise<CharacteristicType>
}

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
