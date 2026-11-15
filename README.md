<p align="center">
  <a href="https://homebridge.io"><img src="https://raw.githubusercontent.com/homebridge/branding/latest/logos/homebridge-color-round-stylized.png" alt="Homebridge Logo" height="140"></a>
</p>
<span align="center">

# HAP Client

[![npm](https://shields.io/npm/v/@homebridge/hap-client/latest)](https://www.npmjs.com/package/@homebridge/hap-client)
[![npm](https://shields.io/npm/dt/@homebridge/hap-client?label=downloads)](https://www.npmjs.com/package/@homebridge/hap-client)<br>
[![Discord](https://img.shields.io/discord/432663330281226270?color=728ED5&logo=discord&label=hb-discord)](https://discord.com/channels/432663330281226270/742733745743855627)

</span>

A client for a HAP-NodeJS instance which runs in insecure mode. It finds the Homebridge bridges on the network, reads their accessories, sets values, and reports changes as they happen.

## Requirements

- Node.js `^22.12.0`, `^24` or `^26`.
- This package is an ES module. Use `import`; `require()` works too on these Node.js versions.
- Each bridge must run in insecure mode (start Homebridge with `-I`), and the client needs the bridge's pin.

## Usage

```ts
import { HapClient } from '@homebridge/hap-client'

const hapClient = new HapClient({
  pin: '031-45-154', // the pin of the bridge
  logger: console,
  config: { debug: false },
})

hapClient.on('instance-discovered', async (instance) => {
  console.log(`Found ${instance.username} at ${instance.ipAddress}:${instance.port}`)

  // every service of every registered bridge
  const services = await hapClient.getAllServices()

  // live updates for those services
  const monitor = await hapClient.monitorCharacteristics(services)
  monitor.on('service-update', (updated) => {
    for (const service of updated) {
      console.log(service.serviceName, service.values)
    }
  })
})
```

### Options

| Option         | Meaning                                                                                                                                                                     |
| -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pin`          | The pin to send to a bridge.                                                                                                                                                |
| `pins`         | Optional. A pin per bridge, by the bridge's username (its MAC address). For child bridges which have a pin of their own. A bridge not listed gets `pin`.                    |
| `ownUsernames` | Optional. The usernames of the bridges which belong to this Homebridge. A pin refused by another Homebridge on the network is then logged at debug level, not as a warning. |
| `logger`       | Optional, `console` by default. An object with any of `debug`, `info`, `warn`, `error`.                                                                                     |
| `config`       | See below.                                                                                                                                                                  |

| `config` key         | Meaning                                                                                                                                                             |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `debug`              | Pass debug lines to the logger.                                                                                                                                     |
| `debugRawPackets`    | Together with `debug`: log complete event-monitor packets and `getValue()` exchanges as text. They can contain the bridge pin, so only turn it on for a short time. |
| `discoveryTimeout`   | How long a discovery runs, in milliseconds. 60000 by default.                                                                                                       |
| `autoStartDiscovery` | Start discovery when the client is created. `true` by default.                                                                                                      |
| `instanceAllowList`  | Usernames of the only bridges to use.                                                                                                                               |
| `instanceDenyList`   | Usernames of bridges to ignore. (`instanceBlacklist` is the old name and still works.)                                                                              |

### Discovery

Discovery starts by itself unless `autoStartDiscovery` is `false`. Every bridge found is tested with the pin before it is registered.

```ts
import { HapClient } from '@homebridge/hap-client'

const hapClient = new HapClient({
  pin: '031-45-154',
  config: { autoStartDiscovery: false, discoveryTimeout: 10000 },
})

hapClient.startDiscovery() // runs for the timeout of the config, 10000 ms
hapClient.startDiscovery(5000) // runs for 5000 ms
hapClient.stopDiscovery() // stop it by hand
hapClient.refreshInstances() // search again (or ask again while a discovery runs)
hapClient.resetInstancePool() // forget every bridge and search again after 6 seconds
hapClient.destroy() // stop everything and close the sockets
```

### Reading and writing

- `getAllServices()` resolves with a `ServiceType` for every service with a known type. Each one carries its characteristics in `serviceCharacteristics`, their last known values in `values`, and helpers such as `refreshCharacteristics()`, `setCharacteristicByType(type, value)` and `getCharacteristic(type)`.
- A characteristic has `getValue()` and `setValue(value)`.
- `uniqueId` identifies a service. `legacyUniqueId` is the id as it was built up to v5.4.0 (two services could share one); use it only to move data saved under an old id.
- A request to a bridge is given up after 15 seconds (30 seconds for a camera snapshot).

### Errors

- A read which the accessory answers with a HAP error status rejects with a `HapCharacteristicError` (exported; it has `aid`, `iid` and `status`, and its `name` is `HapCharacteristicError`). The characteristic keeps its last good `value`, and its `status` holds the HAP status.
- A write which the bridge refuses (the plugin's set handler failed, the value is read-only) rejects with a `HapCharacteristicError` too.
- A write or snapshot request refused because of the pin rejects with an error which names the pin.
- A read from a bridge which can not be reached is logged and resolves with `undefined`.

## Events

`HapClient`:

| Event                            | Arguments  | When                                                                             |
| -------------------------------- | ---------- | -------------------------------------------------------------------------------- |
| `instance-discovered`            | `instance` | A bridge was registered, or a known one changed its port or configuration number |
| `instance-configuration-changed` | `instance` | The accessories of a known bridge changed                                        |
| `discovery-ended`                |            | Discovery ran for its whole timeout                                              |
| `discovery-stopped`              |            | Discovery was stopped with `stopDiscovery()`                                     |
| `discovery-terminated`           |            | A running discovery was cut short by `resetInstancePool()`                       |

The monitor returned by `monitorCharacteristics()`:

| Event             | Arguments            | When                                                 |
| ----------------- | -------------------- | ---------------------------------------------------- |
| `service-update`  | `services`           | Values changed. Each changed service is listed once  |
| `monitor-close`   | `instance, hadError` | The connection to a bridge closed (likely a restart) |
| `monitor-error`   | `instance, error`    | The connection to a bridge had an error              |
| `monitor-refresh` | `instance`           | The connection to a bridge was opened again          |

When a monitored service reports a `StatusActive` change, the monitor reads its other readable, event-enabled characteristics again before it emits `service-update`. This way any HAP error status returned during an availability change is part of the emitted service.

## Dependent Applications

- homebridge-config-ui-x
- homebridge-gsh
- node-red-contrib-homebridge-automation

- [NPM Dependents](https://www.npmjs.com/package/@homebridge/hap-client?activeTab=dependents)

## Credits

- HAP Client was originally created by [oznu](https://github.com/oznu).
