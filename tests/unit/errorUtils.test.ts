import { describe, expect, it } from 'vitest';
import {
  cleanErrorForLogging,
  formatErrorMessage,
  isTemporaryNetworkError,
} from '../../src/common/errorUtils.js';
import { multiaddrToUrl } from '../../src/common/IpfsUtils.js';

describe('cleanErrorForLogging', () => {
  it('returns null for empty input', () => {
    expect(cleanErrorForLogging(null)).toBeNull();
    expect(cleanErrorForLogging(undefined)).toBeNull();
  });

  it('keeps known fields and drops everything else', () => {
    const err = Object.assign(new Error('boom'), {
      code: 'ECONNRESET',
      hostname: 'example.com',
      socket: { huge: Buffer.alloc(1024) },
    });
    const cleaned = cleanErrorForLogging(err);
    expect(cleaned).toMatchObject({ message: 'boom', name: 'Error', code: 'ECONNRESET', hostname: 'example.com' });
    expect(cleaned).not.toHaveProperty('socket');
  });

  it('truncates the stack to 8 lines', () => {
    const stack = Array.from({ length: 20 }, (_, i) => `line ${i}`).join('\n');
    const cleaned = cleanErrorForLogging({ message: 'x', stack });
    expect(cleaned?.stack?.split('\n')).toHaveLength(8);
  });
});

describe('formatErrorMessage', () => {
  it.each([
    [null, 'Unknown error'],
    [{ code: 'ENOTFOUND', hostname: 'h' }, 'Network error: Cannot resolve hostname h'],
    [{ code: 'ECONNREFUSED' }, 'Connection refused: server is not responding'],
    [{ status: 404 }, 'Resource not found (404)'],
    [{ status: 503 }, 'Service unavailable (503)'],
    [new Error('plain'), 'plain'],
  ])('formats %j', (input, expected) => {
    expect(formatErrorMessage(input)).toBe(expected);
  });
});

describe('isTemporaryNetworkError', () => {
  it('flags transient codes, statuses and messages', () => {
    expect(isTemporaryNetworkError({ code: 'ECONNRESET' })).toBe(true);
    expect(isTemporaryNetworkError({ status: 502 })).toBe(true);
    expect(isTemporaryNetworkError(new Error('request timeout'))).toBe(true);
  });

  it('does not flag permanent errors', () => {
    expect(isTemporaryNetworkError(null)).toBe(false);
    // Returns undefined (not false) when the error has no message; callers only test truthiness.
    expect(isTemporaryNetworkError({ status: 404 })).toBeFalsy();
    expect(isTemporaryNetworkError(new Error('invalid input'))).toBe(false);
  });
});

describe('multiaddrToUrl', () => {
  it('converts an ip4/tcp multiaddr', () => {
    expect(multiaddrToUrl('/ip4/192.168.1.100/tcp/5001')).toBe('http://192.168.1.100:5001');
  });

  it('falls back to localhost when unparseable', () => {
    expect(multiaddrToUrl('garbage')).toBe('http://127.0.0.1:5001');
  });
});
