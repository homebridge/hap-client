# Change Log

All notable changes to `@homebridge/hap-client` will be documented in this file. This project tries to adhere to [Semantic Versioning](http://semver.org/).

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
