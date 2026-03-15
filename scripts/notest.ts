import { HapClient } from '../src/index.js';

const client = new HapClient({
  pin: '000-00-000',
  logger: console,
  config: {
    debug: true
  }
});
