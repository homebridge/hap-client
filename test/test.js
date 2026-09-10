/* eslint-disable no-console -- This manual test reports results to the terminal. */
import process from 'node:process'

// eslint-disable-next-line antfu/no-import-dist -- Exercise the local build directly.
import { HapClient } from '../dist/index.js'

// Build first: npm run build
// Run: HAP_PIN=031-45-154 node test/test.js
// Homebridge must be running in insecure mode (-I).
const pin = process.env.HAP_PIN
if (!pin) {
  console.error('Set HAP_PIN to your Homebridge PIN, e.g. HAP_PIN=031-45-154 node test/test.js')
  process.exit(1)
}

const client = new HapClient({
  pin,
  logger: console,
  config: {
    autoStartDiscovery: false,
    discoveryTimeout: 5000,
    debug: process.env.HAP_DEBUG === '1',
    instanceWhitelist: ['69:62:B7:AE:38:D4'],
  },
})

process.once('SIGINT', () => {
  client.destroy()
  process.exit(130)
})
process.once('SIGTERM', () => {
  client.destroy()
  process.exit(143)
})

client.on('instance-discovered', (instance) => {
  console.log(`Found ${instance.name} (${instance.username}) at ${instance.ipAddress}:${instance.port}`)
})

client.once('discovery-ended', async () => {
  try {
    const services = await client.getAllServices()
    console.log(`\nFound ${services.length} service(s).`)
    for (const service of services) {
      console.log(`\n${service.serviceName} (${service.type}) — ${service.instance.username}`)
      console.table(service.serviceCharacteristics.map(characteristic => ({
        type: characteristic.type,
        value: characteristic.value,
        readable: characteristic.canRead,
        writable: characteristic.canWrite,
      })))
    }
    if (!services.length) {
      console.log('Check that Homebridge is on this network, runs with -I, and uses the supplied PIN.')
    }

    const target = services.find(service =>
      service.serviceName === 'Fault Tamper Test Sensor'
      && service.instance.username.toUpperCase() === '69:62:B7:AE:38:D4',
    )
    if (!target) {
      throw new Error('Fault Tamper Test Sensor was not found on bridge 69:62:B7:AE:38:D4.')
    }

    // Read each readable characteristic to exercise per-characteristic HAP errors.
    for (const characteristic of target.serviceCharacteristics.filter(c => c.canRead)) {
      try {
        const result = await client.getCharacteristic(target, characteristic.iid)
        if (result?.value === undefined) {
          console.error(`${target.serviceName} ${characteristic.type} unavailable: no value returned.`)
        } else {
          console.log(`${target.serviceName} ${characteristic.type}:`, result.value)
        }
      } catch (error) {
        console.error(`${target.serviceName} ${characteristic.type} unavailable:`, error.message)
      }
    }

    if (!target.serviceCharacteristics.some(c => c.ev)) {
      throw new Error('Fault Tamper Test Sensor does not support change notifications.')
    }

    const monitor = await client.monitorCharacteristics([target])
    monitor.on('service-update', (updatedServices) => {
      for (const service of updatedServices) {
        console.log(`[${new Date().toISOString()}] ${service.serviceName}:`, service.values)
      }
    })
    monitor.on('monitor-error', (instance, error) => {
      console.error(`Monitor error for ${instance.username}:`, error)
    })
    monitor.on('monitor-close', (instance, hadError) => {
      console.warn(`Monitor connection closed for ${instance.username} (error: ${hadError}).`)
    })
    console.log('\nMonitoring Fault Tamper Test Sensor for characteristic updates. Press Ctrl+C to stop.')
  } catch (error) {
    console.error('HAP client test failed:', error)
    process.exitCode = 1
    client.destroy()
  }
})

console.log('Discovering Homebridge instances for 5 seconds...')
client.startDiscovery()
