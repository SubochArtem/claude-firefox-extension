import { describe, expect, it } from 'vitest';
import { MAX_NETWORK_LIMIT, MAX_URL_PATTERN_LENGTH } from '../../extension/tools/network-input';
import { MAX_NETWORK_REQUESTS_LIMIT, MAX_NETWORK_URL_PATTERN_LENGTH, networkInputSchema } from '../../shared/tool-definitions';

describe('networkInputSchema', () => {
  it('uses the limits of the extension', () => {
    expect(MAX_NETWORK_REQUESTS_LIMIT).toBe(MAX_NETWORK_LIMIT);
    expect(MAX_NETWORK_URL_PATTERN_LENGTH).toBe(MAX_URL_PATTERN_LENGTH);
  });

  it.each([
    {},
    { tabId: 3 },
    { urlPattern: '/api/', limit: 5, clear: true },
    { limit: MAX_NETWORK_REQUESTS_LIMIT, urlPattern: 'x'.repeat(MAX_NETWORK_URL_PATTERN_LENGTH) },
  ])('accepts %j', (args) => {
    expect(networkInputSchema.safeParse(args).success).toBe(true);
  });

  it.each([
    { tabId: 0 },
    { urlPattern: '' },
    { urlPattern: 3 },
    { urlPattern: 'x'.repeat(MAX_NETWORK_URL_PATTERN_LENGTH + 1) },
    { limit: 0 },
    { limit: 1.5 },
    { limit: MAX_NETWORK_REQUESTS_LIMIT + 1 },
    { clear: 1 },
    { pattern: 'api' },
  ])('rejects %j', (args) => {
    expect(networkInputSchema.safeParse(args).success).toBe(false);
  });
});
