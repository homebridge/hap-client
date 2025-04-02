import axios from 'axios';
import Bonjour from 'bonjour-service';
import { EventEmitter } from 'events';
import { HapClient } from './index';

jest.mock('axios');

jest.mock('bonjour-service', () => {
  return jest.fn().mockImplementation(() => ({
    stop: jest.fn(),
    destroy: jest.fn(),
    find: jest.fn().mockReturnValue({
      start: jest.fn(),
      stop: jest.fn(),
      on: jest.fn()
    })
  }));
});

describe('HapClient', () => {
  let hapClient;
  let mockAxios;
  let mockBonjour;

  beforeEach(() => {
    mockAxios = axios as jest.Mocked<typeof axios>;
    mockBonjour = new Bonjour();
    hapClient = new HapClient({ pin: '123-45-678', config: {} });
  });

  test('should initialize correctly', () => {
    expect(hapClient).toBeInstanceOf(EventEmitter);
  });

  afterEach(() => {
    hapClient.destroy();
  });
});
