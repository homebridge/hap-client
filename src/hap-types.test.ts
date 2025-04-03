import { Categories, Characteristics, Services } from './hap-types';

describe('Services', () => {
  test('should be exported', () => {
    expect(Services).toBeDefined();
  });
  test('should have symmetric mappings for all keys except TelevisionSpeaker', () => {
    Object.keys(Services).forEach((key) => {
      const value = Services[key];
      if (key !== 'TelevisionSpeaker') {
        expect(Services[value]).toBe(key);
      }
    });
  });
  test('00000113-0000-1000-8000-0026BB765291 should be Speaker', () => {
    expect(Services['00000113-0000-1000-8000-0026BB765291']).toBe('Speaker');
  });
  test('length should be 145 or greater', () => {
    expect(Object.keys(Services).length).toBeGreaterThanOrEqual(145);
  });
});

describe('Characteristics', () => {
  test('should be exported', () => {
    expect(Characteristics).toBeDefined();
  });
  test('should have symmetric mappings for all keys', () => {
    Object.keys(Characteristics).forEach((key) => {
      const value = Characteristics[key];
      expect(Characteristics[value]).toBe(key);
    });
  });
  test('length should be 488 or greater', () => {
    expect(Object.keys(Characteristics).length).toBeGreaterThanOrEqual(488);
  });
});

describe('Categories', () => {
  test('should be exported', () => {
    expect(Categories).toBeDefined();
  });
  test('length should be 38 or greater', () => {
    expect(Object.keys(Categories).length).toBeGreaterThanOrEqual(38);
  });
});