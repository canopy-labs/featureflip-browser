import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { createLocalStorageFlagCache, FLAG_CACHE_STORAGE_KEY } from '../core/flag-cache';
import type { FlagValue } from '../types';

const ON: FlagValue = { value: true, variation: 'on', reason: 'fallthrough' };

describe('createLocalStorageFlagCache', () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => vi.restoreAllMocks());

  it('round-trips flags for the same client key and context, marked as persisted', () => {
    const cache = createLocalStorageFlagCache();
    cache.save('sdk_client_a', { user_id: 'u1' }, { f: ON });

    expect(createLocalStorageFlagCache().load('sdk_client_a', { user_id: 'u1' })).toEqual({
      f: { value: true, variation: 'on', reason: 'persisted' },
    });
  });

  it('ignores context key order', () => {
    const cache = createLocalStorageFlagCache();
    cache.save('k', { user_id: 'u1', plan: 'pro' }, { f: ON });
    expect(cache.load('k', { plan: 'pro', user_id: 'u1' })).not.toBeNull();
  });

  it('never serves one context the values persisted for another', () => {
    const cache = createLocalStorageFlagCache();
    cache.save('k', { user_id: 'u1' }, { f: ON });
    expect(cache.load('k', { user_id: 'u2' })).toBeNull();
    expect(cache.load('k', { user_id: 'u1', plan: 'pro' })).toBeNull();
  });

  it('never serves one client key the values persisted for another', () => {
    const cache = createLocalStorageFlagCache();
    cache.save('k1', { user_id: 'u1' }, { f: ON });
    expect(cache.load('k2', { user_id: 'u1' })).toBeNull();
  });

  it('does not store the raw context', () => {
    createLocalStorageFlagCache().save('k', { user_id: 'u1', email: 'a@example.com' }, { f: ON });
    expect(localStorage.getItem(FLAG_CACHE_STORAGE_KEY)).not.toContain('a@example.com');
  });

  it('drops a stored prerequisiteKey, since the reason no longer says prerequisite-failed', () => {
    const cache = createLocalStorageFlagCache();
    cache.save('k', {}, {
      f: { value: false, variation: 'off', reason: 'prerequisite-failed', prerequisiteKey: 'p' },
    });
    expect(cache.load('k', {})).toEqual({ f: { value: false, variation: 'off', reason: 'persisted' } });
  });

  it('keeps only the most recently saved contexts', () => {
    let t = 0;
    const cache = createLocalStorageFlagCache(2, () => ++t);
    cache.save('k', { user_id: 'u1' }, { f: ON });
    cache.save('k', { user_id: 'u2' }, { f: ON });
    cache.save('k', { user_id: 'u1' }, { f: ON }); // refreshes u1
    cache.save('k', { user_id: 'u3' }, { f: ON });

    expect(cache.load('k', { user_id: 'u1' })).not.toBeNull();
    expect(cache.load('k', { user_id: 'u2' })).toBeNull();
    expect(cache.load('k', { user_id: 'u3' })).not.toBeNull();
  });

  it('treats corrupt storage as empty and recovers on the next save', () => {
    localStorage.setItem(FLAG_CACHE_STORAGE_KEY, '{not json');
    const cache = createLocalStorageFlagCache();
    expect(cache.load('k', {})).toBeNull();
    cache.save('k', {}, { f: ON });
    expect(cache.load('k', {})).not.toBeNull();
  });

  it('skips malformed flag entries but keeps the valid ones', () => {
    const cache = createLocalStorageFlagCache();
    cache.save('k', {}, { f: ON });
    const stored = JSON.parse(localStorage.getItem(FLAG_CACHE_STORAGE_KEY)!);
    const entry = Object.values(stored.entries)[0] as { flags: Record<string, unknown> };
    entry.flags.bad = 'not-a-flag';
    entry.flags.noVariation = { value: 1 };
    localStorage.setItem(FLAG_CACHE_STORAGE_KEY, JSON.stringify(stored));

    expect(cache.load('k', {})).toEqual({ f: { value: true, variation: 'on', reason: 'persisted' } });
  });

  it('never throws on malformed entries written by someone else', () => {
    localStorage.setItem(
      FLAG_CACHE_STORAGE_KEY,
      JSON.stringify({ version: 1, entries: { x: null, y: 'junk', z: { savedAt: 'soon' } } }),
    );
    const cache = createLocalStorageFlagCache(2);
    expect(() => cache.save('k', {}, { f: ON })).not.toThrow();
    expect(cache.load('k', {})).not.toBeNull();
  });

  it('never throws when localStorage throws', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('SecurityError');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('QuotaExceededError');
    });
    const cache = createLocalStorageFlagCache();
    expect(() => cache.save('k', {}, { f: ON })).not.toThrow();
    expect(cache.load('k', {})).toBeNull();
  });

  it('on a quota error, retries with only the current context', () => {
    const cache = createLocalStorageFlagCache();
    cache.save('k', { user_id: 'old' }, { f: ON });

    const realSetItem = Storage.prototype.setItem;
    let calls = 0;
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, key, value) {
      calls++;
      if (calls === 1) throw new Error('QuotaExceededError');
      realSetItem.call(this, key, value);
    });
    cache.save('k', { user_id: 'new' }, { f: ON });

    expect(cache.load('k', { user_id: 'new' })).not.toBeNull();
    expect(cache.load('k', { user_id: 'old' })).toBeNull();
  });

  it('does not persist a context that cannot be serialized', () => {
    const ctx: Record<string, unknown> = { user_id: 'u1' };
    ctx.self = ctx;
    const cache = createLocalStorageFlagCache();
    expect(() => cache.save('k', ctx, { f: ON })).not.toThrow();
    expect(cache.load('k', ctx)).toBeNull();
  });
});
