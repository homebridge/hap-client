import { Socket } from 'net';

export interface HapInstance {
  name: string;
  ipAddress: string;
  port: number;
  username: string;
  connectionFailedCount: number;
}

export interface HapEvInstance {
  name: string;
  ipAddress: string;
  port: number;
  username: string;
  evCharacteristics?: { aid: number, iid: number, ev: boolean }[];
  socket?: Socket;
}

export interface HapAccessoriesRespType {
  accessories: Array<{
    instance: {
      ipAddress: string;
      port: number;
      username: string;
      name: string;
    };
    aid: number;
    services: Array<{
      iid: number;
      type: string;
      primary: boolean;
      hidden: boolean;
      linked?: Array<number>;
      characteristics: Array<{
        iid: number;
        type: string;
        description: string;
        value: number | string | boolean;
        format: 'bool' | 'int' | 'float' | 'string' | 'uint8' | 'uint16' | 'uint32' | 'uint64' | 'data' | 'tlv8' | 'array' | 'dictionary';
        perms: Array<'pr' | 'pw' | 'ev' | 'aa' | 'tw' | 'hd'>;
        unit?: 'unit' | 'percentage' | 'celsius' | 'arcdegrees' | 'lux' | 'seconds';
        maxValue?: number;
        minValue?: number;
        minStep?: number;
      }>;
    }>;
  }>;
}

export interface HapCharacteristicRespType {
  characteristics: {
    aid: number;
    iid: number;
    value: number | string | boolean;
  }[];
}

export interface ServiceType {
  aid: number;
  iid: number;
  uuid: string;
  type: string;
  linked?: Array<number>;
  linkedServices?: {
    [iid: number]: ServiceType;
  };
  hidden?: boolean;
  humanType: string;
  serviceName: string;
  serviceCharacteristics: CharacteristicType[];
  accessoryInformation: any;
  refreshCharacteristics?: () => Promise<ServiceType>;
  setCharacteristic?: (iid: number, value: number | string | boolean) => Promise<ServiceType>;
  getCharacteristic?: (type: string) => CharacteristicType;
  values: any;
  instance: {
    ipAddress: string;
    port: number;
    username: string;
    name: string;
  };
  uniqueId?: string;
}

export interface CharacteristicType {
  aid: number;
  iid: number;
  uuid: string;
  type: string;
  serviceType: string;
  serviceName: string;
  description: string;
  value: number | string | boolean;
  format: 'bool' | 'int' | 'float' | 'string' | 'uint8' | 'uint16' | 'uint32' | 'uint64' | 'data' | 'tlv8' | 'array' | 'dictionary';
  perms: Array<'pr' | 'pw' | 'ev' | 'aa' | 'tw' | 'hd'>;
  unit?: 'unit' | 'percentage' | 'celsius' | 'arcdegrees' | 'lux' | 'seconds';
  maxValue?: number;
  minValue?: number;
  minStep?: number;
  canRead: boolean;
  canWrite: boolean;
  ev: boolean;
  setValue?: (value: number | string | boolean) => Promise<CharacteristicType>;
  getValue?: () => Promise<CharacteristicType>;
}
