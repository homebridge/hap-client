<p align="center">
  <a href="https://homebridge.io"><img src="https://raw.githubusercontent.com/homebridge/branding/latest/logos/homebridge-color-round-stylized.png" height="140"></a>
</p>
<span align="center">

# HAP Client

[![npm](https://badgen.net/npm/v/@homebridge/hap-client/latest)](https://www.npmjs.com/package/@homebridge/hap-client)
[![npm](https://badgen.net/npm/dt/@homebridge/hap-client?label=downloads)](https://www.npmjs.com/package/@homebridge/hap-client)
[![Discord](https://badgen.net/discord/online-members/C87Pvq3?icon=discord&label=discord)](https://discord.gg/C87Pvq3)
[![Donate](https://badgen.net/badge/donate/paypal/yellow)](https://paypal.me/oznu)

</span>

A client for an insecure HAP-NodeJS instance. Provides a Typescript based interface based on the homekit accessory protocol, allowing the creation of clients able to connect to and control Homebridge devices.

# API

```
const { HapClient } = require('@homebridge/hap-client');

this.hapClient = new HapClient({
  config: { debug: true },
  pin: config.username,
  logger: this.log,
});

this.monitor = await this.hapClient.monitorCharacteristics(services?: ServiceType[]);  // Creates event monitors for all event capabable Homebridge services.  If a list of services is, this list is used rather than all
```

## hap-client Events

```
this.hapClient.on('instance-discovered', this.instanceDiscovered(instance: HapInstance));  // Emitted during discovery for each HB instance discovered

this.hapClient.on('instance-configuration-changed', this.instanceChanged(instance: HapInstance));  // Emitted during discovery for each HB instance change

this.hapClient.on('discovery-terminated', this.discoveryTerminated());  // Instance discovery was terminated

this.hapClient.on('discovery-ended', this.discoveryEnded());  // Emitted when discovery has ended ( 60 Seconds )

this.monitor.on('service-update', this.serviceUpdate(services)); // Emitted when a characteristic change is received from a homebridge service

this.monitor.on('monitor-close', this.monitorClose(instance, hadError)); // Emitted when the connection to a homebridge service is closed ( likely a restart )

this.monitor.on('monitor-error', this.monitorError(instance, error)); // Emitted when the connection to a homebridge service has an error ( likely a restart )

this.monitor.on('monitor-refresh', this.monitorRefresh(instance, error)); // Emitted when the connection to a homebridge instance has been refreshed ( Triggered when an instance is discovered and its port, configuration number or name has changed)
```


# Dependant Applications

- homebridge-config-ui-x
- homebridge-gsh
- node-red-contrib-homebridge-automation

- [NPM Dependants](https://www.npmjs.com/package/@homebridge/hap-client?activeTab=dependents)

## Credits

- HAP Client was originally created by [oznu](https://github.com/oznu).
