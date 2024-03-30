import { HapClient } from '../src'

const client = new HapClient({
  pin: '000-00-000',
  logger: console,
  config: {
    debug: true
  }
});
