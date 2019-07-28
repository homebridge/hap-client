import 'source-map-support/register';

import * as crypto from 'crypto';
import { HAPNodeJSClient } from 'hap-node-client';
import { Services, Characteristics } from './hap-types';
import { HapAccessoriesRespType, ServiceType, CharacteristicType } from './interfaces';

import { get, put } from 'request-promise';
import * as decamelize from 'decamelize';
import * as inflection from 'inflection';

export type HapAccessoriesRespType = HapAccessoriesRespType;
export type ServiceType = ServiceType;
export type CharacteristicType = CharacteristicType;

export class HapClient {
  private hap: HAPNodeJSClient;
  private pin: string;
  private instances = [];
  private logger;

  private hiddenServices = [
    Services.AccessoryInformation
  ];

  private hiddenCharacteristics = [
    Characteristics.Name
  ];

  constructor(pin: string, logger?: any) {
    this.pin = pin;
    this.logger = logger;

    this.hap = new HAPNodeJSClient({
      pin: this.pin,
      debug: false,
      timeout: 5,
    });

    this.hap.on('Ready', () => {
      this.ready();
    });
  }

  private async ready() {
    return new Promise((resolve, reject) => {
      this.hap.HAPaccessories(async (instances) => {
        this.instances = [];
        for (const instance of instances) {
            this.instances.push({
              ipAddress: instance.ipAddress,
              port: instance.instance.port,
              username: instance.instance.txt.id,
              name: instance.instance.txt.md,
            });
        }
      });
    });
  }

  private async getAccessories() {
    const accessories = [];
    for (const instance of this.instances) {
      try {
        const resp: HapAccessoriesRespType = await get(`http://${instance.ipAddress}:${instance.port}/accessories`, { json: true });
        for (const accessory of resp.accessories) {
          accessory.instance = instance;
          accessories.push(accessory);
        }
      } catch (e) {
        if (this.logger) {
          this.logger.error(`Failed to connect to Homebridge instance ${instance.username}`);
        }
      }
    }
    return accessories;
  }

  async getAllServices() {
    /* Get Accessories from HAP */
    const accessories = await this.getAccessories();

    const services: Array<ServiceType> = [];

    /* Parse All Accessories */
    accessories.forEach(accessory => {

      /* Parse Accessory Information */
      const accessoryInformationService = accessory.services.find(x => x.type === Services.AccessoryInformation);
      const accessoryInformation = {};

      if (accessoryInformationService && accessoryInformationService.characteristics) {
        accessoryInformationService.characteristics.forEach((c) => {
          if (c.value) {
            accessoryInformation[c.description] = c.value;
          }
        });
      }

      /* Parse All Services */
      accessory.services
        .filter((s) => this.hiddenServices.indexOf(s.type) < 0 && Services[s.type])
        .map((s) => {
          let serviceName = s.characteristics.find(x => x.type === Characteristics.Name);

          /* Set default name characteristic if none defined */
          serviceName = serviceName ? serviceName : {
            iid: 0,
            type: Characteristics.Name,
            description: 'Name',
            format: 'string',
            value: this.humanizeString(Services[s.type]),
            perms: ['pr']
          };

          /* Parse Service Characteristics */
          const serviceCharacteristics: Array<CharacteristicType> = s.characteristics
            .filter((c) => this.hiddenCharacteristics.indexOf(c.type) < 0 && Characteristics[c.type])
            .map((c) => {
              return {
                aid: accessory.aid,
                iid: c.iid,
                uuid: c.type,
                type: Characteristics[c.type],
                serviceType: Services[s.type],
                serviceName: serviceName.value.toString(),
                description: c.description,
                value: c.value,
                format: c.format,
                perms: c.perms,
                unit: c.unit,
                maxValue: c.maxValue,
                minValue: c.minValue,
                minStep: c.minStep,
                canRead: c.perms.includes('pr'),
                canWrite: c.perms.includes('pw')
              };
            });

          const service: ServiceType = {
            aid: accessory.aid,
            iid: s.iid,
            uuid: s.type,
            type: Services[s.type],
            humanType: this.humanizeString(Services[s.type]),
            serviceName: serviceName.value.toString(),
            serviceCharacteristics: serviceCharacteristics,
            accessoryInformation: accessoryInformation,
            values: {},
            linked: s.linked,
            instance: accessory.instance,
          };

          // generate unique id for service
          service.uniqueId = crypto.createHash('sha256')
            .update(`${service.instance.username}${service.aid}${service.iid}${service.type}`)
            .digest('hex');

          /* Helper function to trigger a call to the accessory to get all the characteristic values */
          service.refreshCharacteristics = () => {
            return this.refreshServiceCharacteristics.bind(this)(service);
          };

          /* Helper function to set the value of a characteristic */
          service.setCharacteristic = (iid: number, value: number | string | boolean) => {
            return this.setCharacteristic.bind(this)(service, iid, value);
          };

          /* Helper function to returns a characteristic by it's type name */
          service.getCharacteristic = (type: string) => {
            return service.serviceCharacteristics.find(c => c.type === type);
          };

          service.serviceCharacteristics.forEach((c) => {
            /* Helper function to set the value of a characteristic */
            c.setValue = async (value: number | string | boolean) => {
              return await this.setCharacteristic.bind(this)(service, c.iid, value);
            };

            /* Helper function to get the value of a characteristic from the accessory */
            c.getValue = async () => {
              return await this.getCharacteristic.bind(this)(service, c.iid);
            };

            /* set the values for each characteristic type in an easy-to-access object */
            service.values[c.type] = c.value;
          });

          services.push(service);
        });
    });

    return services;
  }

  async getService(iid: number) {
    const services = await this.getAllServices();
    return services.find(x => x.iid === iid);
  }

  async getServiceByName(serviceName: string) {
    const services = await this.getAllServices();
    return services.find(x => x.serviceName === serviceName);
  }

  async refreshServiceCharacteristics(service: ServiceType) {
    const iids: number[] = service.serviceCharacteristics.map(c => c.iid);

    const resp = await get(`http://${service.instance.ipAddress}:${service.instance.port}/characteristics`, {
      qs: {
        id: iids.map(iid => `${service.aid}.${iid}`).join(',')
      },
      json: true
    });

    resp.characteristics.forEach((c) => {
      const characteristic = service.serviceCharacteristics.find(x => x.iid === c.iid && x.aid === service.aid);
      characteristic.value = c.value;
    });

    return service;
  }

  async getCharacteristic(service: ServiceType, iid: number) {
    const resp = await get(`http://${service.instance.ipAddress}:${service.instance.port}/characteristics`, {
      qs: {
        id: `${service.aid}.${iid}`
      },
      json: true
    });

    const characteristic = service.serviceCharacteristics.find(x => x.iid === resp.characteristics[0].iid && x.aid === service.aid);
    characteristic.value = resp.characteristics[0].value;

    return characteristic;
  }

  async setCharacteristic(service: ServiceType, iid: number, value: number | string | boolean) {
    try {
      await put(`http://${service.instance.ipAddress}:${service.instance.port}/characteristics`, {
        headers: {
          Authorization: this.pin
        },
        json: {
          characteristics: [
            {
              aid: service.aid,
              iid: iid,
              value: value
            }
          ]
        }
      });
      return this.getCharacteristic(service, iid);
    } catch (e) {
      if (this.logger) {
        this.logger.error(`[${service.instance.name} (${service.instance.username})] Failed to set value for ${service.serviceName}.`);
        if (e.statusCode === 401) {
          this.logger.warn(`[${service.instance.name} (${service.instance.username})] ` +
          `Make sure Homebridge pin for this instance is set to ${this.pin}.`);
        } else {
          this.logger.error(e.message);
        }
      } else {
        console.log(e);
      }
    }
  }

  private humanizeString(string: string) {
    return inflection.titleize(decamelize(string));
  }

}
