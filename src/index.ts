import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';

import axios from 'axios';
import Bonjour, { Browser, Service } from 'bonjour-service';
import * as decamelize from 'decamelize';
import { titleize } from 'inflection';

import 'source-map-support/register';
import { Characteristics, Services } from './hap-types';
import { AccessoryInformationProperties, CharacteristicType, HapAccessoriesRespType, HapCharacteristicRespType, HapInstance, ResourceRequestType, ServiceType } from './interfaces';
import { HapMonitor } from './monitor';
import { toLongFormUUID } from './uuid';

export * from './interfaces';

export class HapClient extends EventEmitter {
  private bonjour = new Bonjour();
  private browser: Browser;
  private discoveryInProgress = false;

  private logger: any;
  private pin: string;
  private debugEnabled: boolean = false;
  private config: {
    debug?: boolean;
    instanceBlacklist?: string[];
  };

  private instances: HapInstance[] = [];

  private hiddenServices = [Services.AccessoryInformation];
  private hiddenCharacteristics = [Characteristics.Name];

  private resetInstancePoolTimeout: NodeJS.Timeout | undefined = undefined;
  private startDiscoveryTimeout: NodeJS.Timeout | undefined = undefined;
  private hapMonitor: HapMonitor;

  constructor(opts: {
    pin: string;
    logger?: any;
    config: any;
  }) {
    super();
    this.pin = opts.pin;
    this.logger = opts.logger || console; // Fallback to console if no logger is provided
    this.debugEnabled = !!opts.config.debug;
    this.config = opts.config;
    this.startDiscovery();
  }

  /**
   * Unified logging method.
   */
  private logMessage(level: 'debug' | 'info' | 'warn' | 'error', msg: string, includeStack = false) {
    if (!this.logger || typeof this.logger[level] !== 'function') {
      return;
    }

    const message = includeStack
      ? `${msg} @ ${new Error().stack?.split('\n')[3]?.trim()}`
      : msg;

    if (level === 'debug' && !this.debugEnabled) return;
    this.logger[level](message);
  }

  debug(msg: string) {
    this.logMessage('debug', msg, true);
  }

  info(msg: string) {
    this.logMessage('info', msg);
  }

  warn(msg: string) {
    this.logMessage('warn', msg);
  }

  error(msg: string) {
    this.logMessage('error', msg);
  }

  // Example usage in methods
  public resetInstancePool() {
    if (this.discoveryInProgress) {
      this.browser.stop();
      this.debug(`[HapClient] Discovery :: Terminated`);
      this.discoveryInProgress = false;
      this.emit('discovery-terminated');
    }

    this.instances = [];
    this.resetInstancePoolTimeout = setTimeout(() => {
      this.refreshInstances();
    }, 6000);
  }

  /**
   * refreshInstances - Refresh the instance pool
   */
  public refreshInstances() {
    if (!this.discoveryInProgress) {
      this.startDiscovery();
    } else {
      try {
        this.debug(`[HapClient] Discovery :: Re-broadcasting discovery query`);
        this.browser.update();
      } catch (e) { }
    }
  }

  private async startDiscovery() {
    this.discoveryInProgress = true;

    this.browser = this.bonjour.find({
      type: 'hap',
    });

    // start matching services
    this.browser.start();
    this.debug(`[HapClient] Discovery :: Started`);

    // stop discovery after 60 seconds
    this.startDiscoveryTimeout = setTimeout(() => {
      this.browser.stop();
      this.debug(`[HapClient] Discovery :: Ended`);
      this.discoveryInProgress = false;
      this.emit('discovery-ended');
    }, 60000);

    // service found
    this.browser.on('up', async (device: Service) => {
      if (!device || !device.txt) {
        this.debug(`[HapClient] Discovery :: Ignoring device that contains no txt records. ${JSON.stringify(device)}`);
        return;
      }

      const instance: HapInstance = {
        name: device.txt.md,
        username: device.txt.id,
        ipAddress: null,
        port: device.port,
        services: [],
        connectionFailedCount: 0,
        configurationNumber: device.txt['c#'],
      };

      this.debug(`[HapClient] Discovery :: Found HAP device with username ${instance.username}`);

      // update an existing instance
      const existingInstanceIndex = this.instances.findIndex(x => x.username === instance.username);
      if (existingInstanceIndex > -1) {
        // ipAddresses change use case is not handled
        const configurationChanged = this.instances[existingInstanceIndex].configurationNumber !== instance.configurationNumber;
        if (
          this.instances[existingInstanceIndex].port !== instance.port ||
          this.instances[existingInstanceIndex].name !== instance.name ||
          configurationChanged
        ) {
          this.instances[existingInstanceIndex].port = instance.port;
          this.instances[existingInstanceIndex].name = instance.name;
          this.instances[existingInstanceIndex].configurationNumber = instance.configurationNumber;
          this.debug(`[HapClient] Discovery :: [${this.instances[existingInstanceIndex].ipAddress}:${instance.port} ` +
            `(${instance.username})] Instance Updated`);
          this.emit('instance-discovered', this.instances[existingInstanceIndex]);
          if (configurationChanged) {
            this.emit('instance-configuration-changed', this.instances[existingInstanceIndex]);
          }
          this.hapMonitor?.refreshMonitorConnection(this.instances[existingInstanceIndex]);
        }

        return;
      }

      // check instance is not on the blacklist
      if (this.config.instanceBlacklist && this.config.instanceBlacklist.find(x => instance.username.toLowerCase() === x.toLowerCase())) {
        this.debug(`[HapClient] Discovery :: Instance with username ${instance.username} found in blacklist. Disregarding.`);
        return;
      }

      for (const ip of device.addresses) {
        if (ip.match(/^(?:(25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9][0-9]|[0-9])(\.(?!$)|$)){4}$/)) {
          try {
            this.debug(`[HapClient] Discovery :: Testing ${instance.username} via http://${ip}:${device.port}/accessories`);
            const test: HapAccessoriesRespType = (await axios.get(`http://${ip}:${device.port}/accessories`, {
              timeout: 10000,
            })).data;
            if (test.accessories) {
              this.debug(`[HapClient] Discovery :: Success ${instance.username} via http://${ip}:${device.port}/accessories`);
              instance.ipAddress = ip;
            }
            break;
          } catch (e) {
            this.debug(`[HapClient] Discovery :: Failed ${instance.username} via http://${ip}:${device.port}/accessories`);
            this.debug(`[HapClient] Discovery :: Failed ${instance.username} with error: ${e.message}`);
          }
        }
      }

      // store instance record if the connection works
      if (instance.ipAddress && await this.checkInstanceConnection(instance)) {
        this.instances.push(instance);
        this.debug(`[HapClient] Discovery :: [${instance.ipAddress}:${instance.port} (${instance.username})] Instance Registered`);
        this.emit('instance-discovered', instance);
        this.hapMonitor?.refreshMonitorConnection(instance);
      } else {
        this.debug(`[HapClient] Discovery :: Could not register to device with username ${instance.username}`);
      }
    });

  }

  /**
   * This checks the instance pin matches
   */
  private async checkInstanceConnection(instance: HapInstance): Promise<boolean> {
    try {
      await axios.put(`http://${instance.ipAddress}:${instance.port}/characteristics`,
        {
          characteristics: [{ aid: -1, iid: -1 }],
        },
        {
          headers: {
            Authorization: this.pin,
          },
        }
      );
      return true;
    } catch (e) {
      this.debug(`[HapClient] Discovery :: [${instance.ipAddress}:${instance.port} (${instance.username})] returned an error while attempting connection: ${e.message}`);
      return false;
    }
  }

  private async getAccessories(): Promise<HapAccessoriesRespType['accessories']> {
    if (!this.instances.length) {
      this.debug('[HapClient] Cannot load accessories. No Homebridge instances have been discovered.');
    }

    const accessories = [];
    for (const instance of this.instances) {
      try {
        const resp: HapAccessoriesRespType = (await axios.get(`http://${instance.ipAddress}:${instance.port}/accessories`)).data;
        instance.connectionFailedCount = 0;
        for (const accessory of resp.accessories) {
          accessory.instance = instance;
          accessories.push(accessory);
        }
      } catch (e) {
        instance.connectionFailedCount++;
        this.debug(`[HapClient] [${instance.ipAddress}:${instance.port} (${instance.username})] Failed to connect`);

        if (instance.connectionFailedCount > 5) {
          const instanceIndex = this.instances.findIndex(x => x.username === instance.username && x.ipAddress === instance.ipAddress);
          this.instances.splice(instanceIndex, 1);
          this.debug(`[HapClient] [${instance.ipAddress}:${instance.port} (${instance.username})] Removed From Instance Pool`);
        }
      }
    }
    return accessories;
  }

  /**
   * monitorCharacteristics
   * @param services - Optional array of services to monitor
   * 
   * Creates connections to all Homebridge instances and monitors all characteristics for changes.  Will emit `service-update` events when characteristics change, which can be listened to.
   * @returns 
   */
  public async monitorCharacteristics(services?: ServiceType[]) {
    // If `services` is not provided, retrieve all services
    services = services ?? await this.getAllServices();
    this.hapMonitor = new HapMonitor(this.logger, this.debug.bind(this), this.pin, services);
    return this.hapMonitor;
  }

  /**
   * 
   * @returns Array of all services from all Homebridge instances
   */
  public async getAllServices() {
    /* Get Accessories from HAP */
    const accessories = await this.getAccessories();

    const services: Array<ServiceType> = [];

    /* Parse All Accessories */
    accessories.forEach(accessory => {
      /** Ensure UUIDs are long form */
      for (const service of accessory.services) {
        service.type = toLongFormUUID(service.type);
        for (const characteristic of service.characteristics) {
          characteristic.type = toLongFormUUID(characteristic.type);
        }
      }

      /* Parse Accessory Information */
      const accessoryInformationService = accessory.services.find(x => x.type === Services.AccessoryInformation);
      const accessoryInformation = {} as AccessoryInformationProperties;

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
            value: accessoryInformation.Name || this.humanizeString(Services[s.type]),
            perms: ['pr'],
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
            serviceName: (serviceName.value.toString().length ? serviceName.value.toString() : accessoryInformation.Name),
            serviceCharacteristics,
            accessoryInformation,
            values: {},
            linked: s.linked,
            instance: accessory.instance,
          };

          // generate unique id for service
          service.uniqueId = createHash('sha256')
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

          service.setCharacteristicByType = (type: string, value: number | string | boolean) => {
            return this.setCharacteristicByType.bind(this)(service, type, value);
          };

          service.setCharacteristicsByTypes = (payload: Record<string, string | number | boolean>) => {
            return this.setCharacteristicsByTypes.bind(this)(service, payload);
          };

          /* Helper function to returns a characteristic by it's type name */
          service.getCharacteristic = (type: string) => {
            return service.serviceCharacteristics.find(c => c.type === type);
          };

          if (service.type === 'CameraRTPStreamManagement') {
            service.getResource = (body: ResourceRequestType) => {
              return this.getResource.bind(this)(service, body);
            };
          }
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

  async refreshServiceCharacteristics(service: ServiceType): Promise<ServiceType> {
    try {
      const iids: number[] = service.serviceCharacteristics.map(c => c.iid);

      const resp: HapCharacteristicRespType = (await axios.get(`http://${service.instance.ipAddress}:${service.instance.port}/characteristics`, {
        params: {
          id: iids.map(iid => `${service.aid}.${iid}`).join(','),
        }
      })).data;

      resp.characteristics.forEach((c) => {
        const characteristic = service.serviceCharacteristics.find(x => x.iid === c.iid && x.aid === service.aid);
        characteristic.value = c.value;
        service.values[characteristic.type] = c.value;
      });
      return service;
    } catch (e) {
      this.debug(`[HapClient] +${e}`);

      this.error(`[HapClient] Failed to refresh characteristics for ${service.serviceName}: ${e.message}`);

    }
  }

  async getCharacteristic(service: ServiceType, iid: number): Promise<CharacteristicType> {
    try {
      const resp: HapCharacteristicRespType = (await axios.get(`http://${service.instance.ipAddress}:${service.instance.port}/characteristics`, {
        params: {
          id: `${service.aid}.${iid}`,
        },
      })).data;

      const characteristic = service.serviceCharacteristics.find(x => x.iid === resp.characteristics[0].iid && x.aid === service.aid);
      characteristic.value = resp.characteristics[0].value;
      service.values[characteristic.type] = resp.characteristics[0].value;

      return characteristic;
    } catch (e) {
      this.debug(`[HapClient] +${e}`);

      this.error(`[HapClient] Failed to get characteristic for ${service.serviceName} with iid ${iid}: ${e.message}`);

    }
  }

  async setCharacteristicByType(service: ServiceType, type: string, value: number | string | boolean) {
    const characteristic = service.serviceCharacteristics.find(x => x.type === type);
    if (!characteristic) {
      throw new Error(`Characteristic ${type} not found in service ${service.serviceName}`);
    }
    return this.setCharacteristic(service, characteristic.iid, value);
  }

  async setCharacteristic(service: ServiceType, iid: number, value: number | string | boolean) {
    try {
      await axios.put(`http://${service.instance.ipAddress}:${service.instance.port}/characteristics`,
        {
          characteristics: [
            {
              aid: service.aid,
              iid,
              value,
            },
          ],
        },
        {
          headers: {
            Authorization: this.pin,
          },
        }
      );
      return this.getCharacteristic(service, iid);
    } catch (e) {

      this.error(`[HapClient] [${service.instance.ipAddress}:${service.instance.port} (${service.instance.username})] ` +
        `Failed to set value for ${service.serviceName}.`);
      if (e.response && e.response?.status === 470 || e.response?.status === 401) {
        this.warn(`[HapClient] [${service.instance.ipAddress}:${service.instance.port} (${service.instance.username})] ` +
          `Make sure Homebridge pin for this instance is set to ${this.pin}.`);
        throw new Error(`Failed to control accessory. Make sure the Homebridge pin for ${service.instance.ipAddress}:${service.instance.port} ` +
          `is set to ${this.pin}.`);
      } else {
        this.error(e.message);
        throw new Error(`Failed to control accessory: ${e.message}`);
      }

    }
  }

  async setCharacteristicsByTypes(service: ServiceType, payload: Record<string, string | number | boolean>) {
    const characteristics = Object.entries(payload).map(([type, value]) => {
      const characteristic = service.serviceCharacteristics.find(x => x.type === type);
      if (!characteristic) {
        throw new Error(`Characteristic ${type} not found in service ${service.serviceName}`);
      }
      if (type === "Configured Name") {
        // Handle "Configured Name" case explicitly if needed
        return null;
      }
      return {
        aid: service.aid,
        iid: characteristic.iid,
        value,
      };
    }).filter(item => item !== null);
    return this.setCharacteristics(service, characteristics);
  }

  async setCharacteristics(service: ServiceType, characteristics: { aid: number, iid: number, value: string | number | boolean }[]) {
    try {
      await axios.put(`http://${service.instance.ipAddress}:${service.instance.port}/characteristics`,
        {
          characteristics: characteristics,
        },
        {
          headers: {
            Authorization: this.pin,
          },
        }
      );
      return this.refreshServiceCharacteristics(service);
    } catch (e) {

      this.error(`[HapClient] [${service.instance.ipAddress}:${service.instance.port} (${service.instance.username})] ` +
        `Failed to set value for ${service.serviceName}.`);
      if (e.response && e.response?.status === 470 || e.response?.status === 401) {
        this.warn(`[HapClient] [${service.instance.ipAddress}:${service.instance.port} (${service.instance.username})] ` +
          `Make sure Homebridge pin for this instance is set to ${this.pin}.`);
        throw new Error(`Failed to control accessory. Make sure the Homebridge pin for ${service.instance.ipAddress}:${service.instance.port} ` +
          `is set to ${this.pin}.`);
      } else {
        this.error(e.message);
        throw new Error(`Failed to control accessory: ${e.message}`);
      }

    }
  }

  async getResource(service: ServiceType, body: ResourceRequestType) {
    try {
      const resp: any = await axios.post(`http://${service.instance.ipAddress}:${service.instance.port}/resource`,
        {
          ...body, aid: service.aid
        },
        {
          responseType: 'arraybuffer',
          headers: {
            Authorization: this.pin,
          },
        }
      );
      if (resp.status === 200) {
        return resp.data;
      } else {

        this.warn(`[HapClient] getResource [${service.instance.ipAddress}:${service.instance.port} (${service.instance.username})] ` +
          `Failed to request resource from accessory ${service.serviceName}. Response status Code ${resp.status}`);

      }
      return;
    } catch (e) {

      this.error(`[HapClient] [${service.instance.ipAddress}:${service.instance.port} (${service.instance.username})] ` +
        `Failed to request resource from accessory ${service.serviceName}.`);
      if (e.response && e.response?.status === 470 || e.response?.status === 401) {
        this.warn(`[HapClient] [${service.instance.ipAddress}:${service.instance.port} (${service.instance.username})] ` +
          `Make sure Homebridge pin for this instance is set to ${this.pin}.`);
        throw new Error(`Failed to request resource from accessory. Make sure the Homebridge pin for ${service.instance.ipAddress}:${service.instance.port} ` +
          `is set to ${this.pin}.`);
      } else {
        this.error(e.message);
        throw new Error(`Failed to request resource: ${e.message}`);
      }

    }
  }

  private humanizeString(string: string) {
    return titleize(decamelize(string));
  }

  /**
   * Destroy the HAP client, used by testing when shutting down
   */
  public async destroy() {
    this.browser?.stop();
    this.hapMonitor?.finish();
    this.discoveryInProgress = false;
    if (this.resetInstancePoolTimeout) {
      clearTimeout(this.resetInstancePoolTimeout)
    }
    if (this.startDiscoveryTimeout) {
      clearTimeout(this.startDiscoveryTimeout)
    }
    this.bonjour.destroy();
  }

}
