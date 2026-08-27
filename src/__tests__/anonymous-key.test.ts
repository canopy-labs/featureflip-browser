import { describe, it, expect } from 'vitest';
import { withAnonymousUserId, createLocalStorageStore, type AnonymousKeyStore } from '../core/anonymous-key';

function memoryStore(initial: string | null = null): AnonymousKeyStore {
  let v = initial;
  return { read: () => v, write: (value) => { v = value; } };
}

describe('withAnonymousUserId', () => {
  it('injects a generated user_id when none is provided and persists it', () => {
    const store = memoryStore();
    const first = withAnonymousUserId({ plan: 'pro' }, store);
    expect(typeof first.user_id).toBe('string');
    expect((first.user_id as string).length).toBeGreaterThan(0);
    // second call reads the SAME persisted key
    const second = withAnonymousUserId({ plan: 'pro' }, store);
    expect(second.user_id).toBe(first.user_id);
  });

  it('passes a real user_id through unchanged', () => {
    const store = memoryStore();
    const out = withAnonymousUserId({ user_id: 'real-123' }, store);
    expect(out.user_id).toBe('real-123');
    expect(store.read()).toBeNull(); // never generated
  });

  it('treats the camelCase userId alias as a real identifier (no injection)', () => {
    const store = memoryStore();
    const out = withAnonymousUserId({ userId: 'alice' }, store);
    expect(out).toEqual({ userId: 'alice' });
    expect(store.read()).toBeNull();
  });

  it('treats blank/whitespace user_id as anonymous', () => {
    const store = memoryStore();
    const out = withAnonymousUserId({ user_id: '   ' }, store);
    expect((out.user_id as string).trim().length).toBeGreaterThan(0);
    expect(out.user_id).not.toBe('   ');
  });

  it('preserves other context fields', () => {
    const store = memoryStore();
    const out = withAnonymousUserId({ plan: 'pro', country: 'US' }, store);
    expect(out.plan).toBe('pro');
    expect(out.country).toBe('US');
    expect(typeof out.user_id).toBe('string');
  });
});

describe('createLocalStorageStore', () => {
  it('stays sticky within the session when localStorage is unavailable', () => {
    const original = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
    // Simulate blocked storage: every access to localStorage throws.
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      get() {
        throw new Error('storage blocked');
      },
    });
    try {
      const store = createLocalStorageStore();
      const first = withAnonymousUserId({}, store);
      const second = withAnonymousUserId({}, store);
      expect(typeof first.user_id).toBe('string');
      expect((first.user_id as string).length).toBeGreaterThan(0);
      // Despite storage throwing, the in-memory fallback keeps the id stable.
      expect(second.user_id).toBe(first.user_id);
    } finally {
      if (original) Object.defineProperty(globalThis, 'localStorage', original);
    }
  });
});
