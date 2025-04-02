// uuid.test.ts
import { isValid, toLongFormUUID } from './uuid'; // Adjust the path as needed

describe('UUID Utility', () => {
  describe('isValid', () => {
    it('should return true for a valid long-form UUID', () => {
      const validUUID = '00000000-0000-1000-8000-0026BB765291';
      expect(isValid(validUUID)).toBe(true);
    });

    it('should return false for an invalid UUID', () => {
      const invalidUUID = '12345';
      expect(isValid(invalidUUID)).toBe(false);
    });

    it('should return false for a valid short UUID', () => {
      // A short UUID is valid in its own context but not in the long form
      const shortUUID = '1a2b3c';
      expect(isValid(shortUUID)).toBe(false);
    });
  });

  describe('toLongFormUUID', () => {
    it('should return the same valid long-form UUID in uppercase', () => {
      const longUUID = '00000000-0000-1000-8000-0026bb765291';
      const expected = '00000000-0000-1000-8000-0026BB765291';
      expect(toLongFormUUID(longUUID)).toBe(expected);
    });

    it('should convert a valid short UUID to long form', () => {
      const shortUUID = '1a2b3c';
      // '1a2b3c' should be padded to 8 hex digits: '001a2b3c'
      // then concatenated with the base '-0000-1000-8000-0026BB765291'
      const expected = '001A2B3C-0000-1000-8000-0026BB765291';
      expect(toLongFormUUID(shortUUID)).toBe(expected);
    });

    it('should allow custom base for converting short UUIDs', () => {
      const shortUUID = 'deadbeef';
      const customBase = '-1111-2222-3333-444444444444';
      const expected = 'DEADBEEF-1111-2222-3333-444444444444';
      expect(toLongFormUUID(shortUUID, customBase)).toBe(expected);
    });

    it('should throw an error for an invalid short UUID', () => {
      const invalidShortUUID = 'zzz'; // not a valid hex string
      expect(() => toLongFormUUID(invalidShortUUID)).toThrow('uuid was not a valid UUID or short form UUID');
    });

    it('should throw an error if the base is not valid', () => {
      const shortUUID = '1a2b3c';
      const invalidBase = '-invalid-base';
      expect(() => toLongFormUUID(shortUUID, invalidBase)).toThrow('base was not a valid base UUID');
    });
  });
});
