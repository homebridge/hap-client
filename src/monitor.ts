import { EventEmitter } from 'events';
import { ServiceType, HapEvInstance } from './interfaces';
import { createConnection, parseMessage } from './eventedHttpClient';

export class HapMonitor extends EventEmitter {
  private pin;
  private evInstances: HapEvInstance[];
  private services: ServiceType[];
  private logger;
  private debug;

  constructor(logger, debug, pin: string, services: ServiceType[]) {
    super();
    this.logger = logger;
    this.debug = debug;
    this.pin = pin;
    this.services = services;
    this.evInstances = [];

    // get a list of characteristics we can watch for each instance
    this.parseServices();

    // start watching
    this.start();
  }

  start() {
    for (const instance of this.evInstances) {
      instance.socket = createConnection(instance, this.pin, { characteristics: instance.evCharacteristics });

      this.debug(`[HapClient] [${instance.ipAddress}:${instance.port} (${instance.username})] Connected`);

      instance.socket.on('data', (data) => {
        const message = parseMessage(data);

        if (message.statusCode === 401) {
          if (this.logger) {
            this.debug(`[HapClient] [${instance.ipAddress}:${instance.port} (${instance.username})] ` +
              `${message.statusCode} ${message.statusMessage} - make sure Homebridge pin for this instance is set to ${this.pin}.`);
          }
        }

        if (message.protocol === 'EVENT') {
          try {
            const body = JSON.parse(message.body);
            if (body.characteristics && body.characteristics.length) {
              this.debug(`[HapClient] [${instance.ipAddress}:${instance.port} (${instance.username})] ` +
                `Got Event: ${JSON.stringify(body.characteristics)}`);

              const response = body.characteristics.map((c) => {
                // find the matching service for each characteristics
                const services = this.services.filter(x => x.aid === c.aid && x.instance.username === instance.username);
                const service = services.find(x => x.serviceCharacteristics.find(y => y.iid === c.iid));

                if (service) {
                  // find the correct characteristic and update it
                  const characteristic = service.serviceCharacteristics.find(x => x.iid === c.iid);
                  if (characteristic) {
                    characteristic.value = c.value;
                    service.values[characteristic.type] = c.value;
                    return service;
                  }
                }

              });

              // push update to listeners
              this.emit('service-update', response.filter(x => x));
            }
          } catch (e) {
            // do nothing
          }
        }
      });
    }
  }

  finish() {
    for (const instance of this.evInstances) {
      if (instance.socket) {
        try {
          instance.socket.destroy();
          this.debug(`[HapClient] [${instance.ipAddress}:${instance.port} (${instance.username})] Disconnected`);
        } catch (e) {
          // do nothing
        }
      }
    }
  }

  parseServices() {
    // get a list of characteristics we can watch for each instance
    for (const service of this.services) {
      const evCharacteristics = service.serviceCharacteristics.filter(x => x.perms.includes('ev'));

      if (evCharacteristics.length) {
        // register the instance if it's not already there
        if (!this.evInstances.find(x => x.username === service.instance.username)) {
          const newInstance = Object.assign({}, service.instance) as HapEvInstance;
          newInstance.evCharacteristics = [];
          this.evInstances.push(newInstance);
        }

        const instance = this.evInstances.find(x => x.username === service.instance.username);

        for (const evCharacteristic of evCharacteristics) {
          if (!instance.evCharacteristics.find(x => x.aid === service.aid && x.iid === evCharacteristic.iid)) {
            instance.evCharacteristics.push({ aid: service.aid, iid: evCharacteristic.iid, ev: true });
          }
        }
      }
    }
  }
}
