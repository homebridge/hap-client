/* eslint-disable no-console -- This example intentionally writes discovery results to the terminal. */
import process from 'node:process'

// Build first with `npm run build`; this imports the local package output.
// eslint-disable-next-line antfu/no-import-dist
import { HapClient } from '../dist/index.js'

const accessoryName = process.env.HAP_ACCESSORY ?? 'Backyard Tree'
const pin = process.env.HAP_PIN

if (!pin) {
  console.error('Set HAP_PIN to your Homebridge PIN. See examples/README.md for an invocation.')
  process.exit(1)
}

const client = new HapClient({
  pin,
  logger: console,
  config: {
    autoStartDiscovery: false,
    debug: true,
    debugRawPackets: true,
    discoveryTimeout: 5000,
    instanceWhitelist: ['69:62:B7:AE:38:D4'],
  },
})

function shutDown(exitCode = 0) {
  client.destroy()
  process.exit(exitCode)
}

process.once('SIGINT', () => shutDown(130))
process.once('SIGTERM', () => shutDown(143))

client.on('instance-discovered', (instance) => {
  console.log(`Found ${instance.name} (${instance.username}) at ${instance.ipAddress}:${instance.port}`)
})

client.once('discovery-ended', async () => {
  try {
    console.log(`Discovery has ended`)
    const services = await client.getAllServices()
    const accessoryServices = services.filter(service => service.accessoryInformation?.Name === accessoryName)

    if (!accessoryServices.length) {
      const names = [...new Set(services.map(service => service.accessoryInformation?.Name).filter(Boolean))]
      throw new Error(`Accessory ${JSON.stringify(accessoryName)} was not found. Discovered: ${names.join(', ') || 'none'}`)
    }

    // Values included in the accessories response may be stale. Prime each
    // readable, event-enabled characteristic with its latest value before
    // displaying and monitoring the returned service objects.
    await Promise.all(accessoryServices.flatMap(service =>
      service.serviceCharacteristics
        .filter(characteristic => characteristic.ev && characteristic.canRead)
        .map(async (characteristic) => {
          try {
            console.log(`Retrieving lastest value for ${characteristic.description} ${JSON.stringify(await characteristic.getValue(), null, 2)}`)
          } catch (error) {
            console.warn(`Could not refresh ${service.serviceName} / ${characteristic.type}:`, error)
          }
        }),
    ))

    // A HAP accessory is returned as one ServiceType per service. Services with
    // the same bridge username and aid belong to this single accessory.
    console.dir(accessoryServices, { depth: null, colors: process.stdout.isTTY })

    const eventServices = accessoryServices.filter(service => service.serviceCharacteristics.some(characteristic => characteristic.ev))
    if (!eventServices.length) {
      console.log(`\n${accessoryName} has no event-enabled characteristics, so there are no packets to monitor.`)
      client.destroy()
      return
    }

    const monitor = await client.monitorCharacteristics(eventServices)
    monitor.on('service-update', (updatedServices) => {
      console.log(`\n[${new Date().toISOString()}] ${accessoryName} update:`)
      console.dir(updatedServices, { depth: null, colors: process.stdout.isTTY })
    })
    monitor.on('monitor-error', (instance, error) => {
      console.error(`Monitor error for ${instance.username}:`, error)
    })

    console.log(`\nMonitoring ${JSON.stringify(accessoryName)}. Change its state to see updates; press Ctrl+C to stop.`)
  } catch (error) {
    console.error(error)
    client.destroy()
    process.exitCode = 1
  }
})

console.log(`Discovering bridges for ${JSON.stringify(accessoryName)}...`)
client.startDiscovery()
