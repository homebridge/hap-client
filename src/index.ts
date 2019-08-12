import 'source-map-support/register';
import * as crypto from 'crypto';
import * as decamelize from 'decamelize';
import * as inflection from 'inflection';
import * as Bonjour from 'bonjour';
import { EventEmitter } from 'events';
import { get, put } from 'request-promise-native';

import { Services, Characteristics } from './hap-types';
import { HapMonitor } from './monitor';
import { HapAccessoriesRespType, ServiceType, CharacteristicType, HapInstance } from './interfaces';

export type HapAccessoriesRespType = HapAccessoriesRespType;
export type ServiceType = ServiceType;
export type CharacteristicType = CharacteristicType;

export class HapClient extends EventEmitter {
  private bonjour = Bonjour();
  private browser;

  private logger;
  private pin: string;
  private debugEnabled: boolean;
  private config: {
    debug?: boolean;
    instanceBlacklist?: string[];
  };

  private instances: HapInstance[] = [];

  private hiddenServices = [
    Services.AccessoryInformation
  ];

  private hiddenCharacteristics = [
    Characteristics.Name
  ];

  constructor(opts: {
    pin: string;
    logger?: any;
    config: any;
  }) {
    super();

    this.pin = opts.pin;
    this.logger = opts.logger;
    this.debugEnabled = opts.config.debug;
    this.config = opts.config;
    this.startDiscovery();
  }

  debug(msg) {
    if (this.debugEnabled) {
      this.logger.log(msg);
    }
  }

  public refreshInstances() {
    this.debug(`[HapClient] Discovery :: Sending Hap Discovery Request`);
    this.browser.update();
  }

  private async startDiscovery() {
    this.browser = this.bonjour.find({
      type: 'hap'
    });

    // start matching services
    this.browser.start();
    this.debug(`[HapClient] Discovery :: Started`);

    // service found
    this.browser.on('up', async (device: any) => {
      const instance = {
        name: device.txt.md,
        username: device.txt.id,
        port: device.port,
        services: [],
      } as any;

      this.debug(`[HapClient] Discovery :: Found HAP device with username ${instance.username}`);

      for (const ip of device.addresses) {
        if (ip.match(/^(?:(25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9][0-9]|[0-9])(\.(?!$)|$)){4}$/)) {
          try {
            this.debug(`[HapClient] Discovery :: Testing ${instance.username} via http://${ip}:${device.port}/accessories`);
            const test = await get(`http://${ip}:${device.port}/accessories`, {
              json: true,
              timeout: 1000,
            });
            if (test.accessories) {
              this.debug(`[HapClient] Discovery :: Success ${instance.username} via http://${ip}:${device.port}/accessories`);
              instance.ipAddress = ip;
            }
            break;
          } catch (e) {
            this.debug(`[HapClient] Discovery :: Failed ${instance.username} via http://${ip}:${device.port}/accessories`);
          }
        }
      }

      // check instance is not on the blacklist
      if (instance.ipAddress && this.config.instanceBlacklist) {
        if (this.config.instanceBlacklist.find(x => instance.username.toLowerCase() === x.toLowerCase())) {
          this.debug(`[HapClient] Discovery :: [${instance.ipAddress}:${instance.port} (${instance.username})] ` +
            `Instance found in blacklist. Disregarding.`);
          return;
        }
      }

      // store instance record
      if (instance.ipAddress) {
        const existingInstanceIndex = this.instances.findIndex(x => x.username === instance.username);
        if (existingInstanceIndex > -1) {
          this.instances[existingInstanceIndex] = instance;
          this.debug(`[HapClient] Discovery :: [${instance.ipAddress}:${instance.port} (${instance.username})] Instance Updated`);
        } else {
          this.debug(`[HapClient] Discovery :: [${instance.ipAddress}:${instance.port} (${instance.username})] Instance Registered`);
          this.instances.push(instance);
        }

        // let the client know we discovered a new instance
        this.emit('instance-discovered', instance);
      } else {
        this.debug(`[HapClient] Discovery :: Could not register to device with username ${instance.username}`);
      }
    });

  }

  private async getAccessories() {
    if (!this.instances.length) {
      this.logger.warn('[HapClient] Cannot load accessories. No Homebridge instances have been discovered.');
    }

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
          this.logger.error(`[HapClient] [${instance.ipAddress}:${instance.port} (${instance.username})] Failed to connect`);
        }
      }
    }
    return accessories;
  }

  public async monitorCharacteristics() {
    const services = await this.getAllServices();
    return new HapMonitor(this.logger, this.debug.bind(this), this.pin, services);
  }

  public async getAllServices() {
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
                canWrite: c.perms.includes('pw'),
                ev: c.perms.includes('ev'),
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
        this.logger.error(`[HapClient] [${service.instance.ipAddress}:${service.instance.port} (${service.instance.username})] ` +
          `Failed to set value for ${service.serviceName}.`);
        if (e.statusCode === 401) {
          this.logger.warn(`[HapClient] [${service.instance.ipAddress}:${service.instance.port} (${service.instance.username})] ` +
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
