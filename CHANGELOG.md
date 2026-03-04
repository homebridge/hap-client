# Change Log

All notable changes to `@homebridge/hap-client` will be documented in this file. This project tries to adhere to [Semantic Versioning](http://semver.org/).

## v3.4.0 (2026-02-24)

### Changed

- feat: add `nameBasedUniqueId` for stable device identification across re-pairings
- feat: added more granular control for discovery (#32) (@kovapatrik)
- docs: added new discovery-stopped event to README (#33) (@kovapatrik)
- fix: restore map in monitor to fix service-update events
- chore: dependency updates

### Homebridge Dependencies

- `@homebridge/hap-nodejs` @ `v2.1.0`

## v3.3.0 (2026-02-14)

### Changed

- bump `axios` from `v1.13.4` to `v1.13.5` (#30) (@dependabot)
- update lint and code style + eslint dependencies

### Homebridge Dependencies

- `@homebridge/hap-nodejs` @ `v2.1.0`

## v3.2.0 (2026-02-08)

### Changed

- update dependencies
- regenerate types from `hap-nodejs` in `hap-types.ts`

### Homebridge Dependencies

- `@homebridge/hap-nodejs` @ `v2.1.0`

## v3.1.3 (2026-02-07)

### Changed

- updated dependencies
- update release script for oidc releases

### Homebridge Dependencies

- `@homebridge/hap-nodejs` @ `v2.0.2`

## v3.1.2 (2025-09-13)

### Changed

- update dependencies

### Homebridge Dependencies

- `@homebridge/hap-nodejs` @ `v2.0.1`

## v3.1.1 (2025-07-23)

### Changed

- update dependencies

### Homebridge Dependencies

- `@homebridge/hap-nodejs` @ `v2.0.1`

## v3.1.0 (2025-06-19)

### Changed

- export an enums constant in the hap-types file

### Homebridge Dependencies

- `@homebridge/hap-nodejs` @ `v2.0.0`

## v3.0.0 (2025-06-18)

### Changed

- update `@homebridge/hap-nodejs` to v2
- modernise `tsconfig.json` file
- update `jest` to `v30` and required migration steps
- update `eslint` to `v9` and required migration steps
- update `axios`, regenerate lock file

### Homebridge Dependencies

- `@homebridge/hap-nodejs` @ `v2.0.0`

## v2.2.0 (2025-05-26)

### Changed

- Updated dependencies
- Return `validValues` in characteristic structure

## v2.1.0 (2025-04-22)

### Changed

- Added setCharacteristicsByTypes to support multiple characteristic updates to a single device.  Which resolves, https://github.com/NorthernMan54/node-red-contrib-homebridge-automation/issues/152
- Added initial framework and dependencies to support the creation of test cases.

## v2.0.6 (2025-03-22)

### Changed

- updated dependencies

## v2.0.5 (2024-12-04)

### Changed

- updated dependencies
- Added refresh of 'values' field when refreshServiceCharacteristics or getCharacteristic is used
- Added new setCharacteristic option, setCharacteristicByType which finds characteristic by type for setting.
- Added new getResource request to retrieve snapshot images from camera's
- Minor tweak to serviceName, and if the name is blank, use the name value from Accessory Information
- Fixed issue of error handler triggering an error when attempting to connect to a homebridge instance that is down
- Added restart of monitor when client connections close
- Added console logging if a logger is not provided

## v2.0.4 (2024-11-07)

### Changed

- Added public method destroy, to be used for testing
- Update public method monitorCharacteristics to allow passing of a filtered services array.

## v2.0.2 (2024-08-31)

### Changed

- updated dependencies

## v2.0.1 (2024-07-22)

### Changed

- updated dev dependencies

## v2.0.0 (2024-07-13)

### Breaking Changes

- HAP-NodeJS v1.0.0 is included in this release. In v1.0.0 we have removed old deprecated code.
  - Some examples can be found on the HAP-NodeJS [v1.0.0 Release Notes](https://github.com/homebridge/HAP-NodeJS/releases/tag/v1.0.0).

### Changed

- update dependencies (`axios`)
- update dev dependencies
- update dependencies (`hap-nodejs`)

## v1.10.2 (2024-04-19)

### Changed

- update dev dependencies

## v1.10.1 (2024-04-03)

### Other Changes

- create CHANGELOG file
- update LICENSE to standardise with other hb repos
- update README to standardise with other hb repos
- update dependencies

## v1.10.0 (2024-03-31)

### Other Changes

- Publish as `@homebridge/hap-client` (#9)
