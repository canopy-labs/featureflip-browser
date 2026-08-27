import { describe, it, expect, afterEach } from 'vitest';
import { FeatureflipClient } from '../client';

/**
 * `close()` releases the core — closing the SSE connection and removing the cache
 * entry — but the in-memory snapshot stays readable, so a closed handle kept
 * evaluating against a frozen snapshot that can never update again and reported
 * `isInitialized === true` while doing it (#2327).
 *
 * The contract settled in #2313 and applied to flutter/android in #2326: a closed
 * handle returns the caller's default and reports not-initialized.
 *
 * The fixture seeds real values via `forTesting` on purpose. A client whose fetch
 * failed has an empty store and would return defaults either way, so the stale value
 * has to exist for these assertions to mean anything.
 */
describe('use after close', () => {
  afterEach(() => {
    FeatureflipClient.resetForTesting();
  });

  const seeded = () =>
    FeatureflipClient.forTesting({
      'bool-flag': true,
      'string-flag': 'served',
      'number-flag': 42,
    });

  it('serves real values while open', () => {
    const client = seeded();

    expect(client.boolVariation('bool-flag', false)).toBe(true);
    expect(client.stringVariation('string-flag', 'fallback')).toBe('served');
    expect(client.numberVariation('number-flag', 0)).toBe(42);
    expect(client.isInitialized).toBe(true);
    expect(client.flagDetail('bool-flag')).toBeDefined();

    client.close();
  });

  it('a closed handle serves the caller default, not the stale value', () => {
    const client = seeded();
    client.close();

    // Each default is deliberately the opposite of the cached value, so a stale
    // read is distinguishable from a correct default.
    expect(client.boolVariation('bool-flag', false)).toBe(false);
    expect(client.stringVariation('string-flag', 'fallback')).toBe('fallback');
    expect(client.numberVariation('number-flag', 0)).toBe(0);
    expect(client.jsonVariation('bool-flag', null)).toBeNull();
  });

  it('a closed handle reports not-initialized', () => {
    const client = seeded();
    expect(client.isInitialized).toBe(true);

    client.close();

    expect(client.isInitialized).toBe(false);
  });

  it('a closed handle exposes no flag detail', () => {
    const client = seeded();
    expect(client.flagDetail('bool-flag')).toBeDefined();

    client.close();

    expect(client.flagDetail('bool-flag')).toBeUndefined();
  });

  it('close stays idempotent', () => {
    const client = seeded();

    client.close();
    client.close();

    expect(client.boolVariation('bool-flag', false)).toBe(false);
  });
});
