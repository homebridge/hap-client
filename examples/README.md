# Examples

Build the local package, then inspect and monitor the HomeKit accessory named `Backyard Tree`:

```sh
npm run build
HAP_PIN=031-45-154 node examples/backyard-tree.js
```

During development, use Nodemon to rebuild and restart the example whenever its source or the client source changes:

```sh
HAP_PIN=031-45-154 npm run exampleWatch
```

Homebridge must be running in insecure mode (`-I`). Replace the example PIN with your bridge PIN.

The example limits discovery to bridge `69:62:B7:AE:38:D4`. Once discovery ends, it calls `getValue()` for every readable, event-enabled characteristic before printing the accessory's services, then subscribes to its event-enabled characteristics. Debug output includes each full `getValue()` HTTP response and the complete sent and received event-monitor packets as plain text, which may contain the bridge PIN and other sensitive values.

To inspect a different accessory without editing the file, set `HAP_ACCESSORY`:

```sh
HAP_PIN=031-45-154 HAP_ACCESSORY='Front Porch' node examples/backyard-tree.js
```
