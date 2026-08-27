import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { FeatureflipClient } from '../client';
import type { FlagValue } from '../types';

function mockFetchRaw(responseBody: unknown) {
  return vi.fn().mockResolvedValue({
    ok: true,
    json: () => Promise.resolve(responseBody),
  });
}

function mockEventSource() {
  const listeners: Record<string, (event: MessageEvent) => void> = {};
  const MockES = vi.fn().mockImplementation(function () {
    return {
      addEventListener: vi.fn((type: string, handler: (event: MessageEvent) => void) => {
        listeners[type] = handler;
      }),
      close: vi.fn(),
      onerror: null as (() => void) | null,
    };
  });
  return { MockES, listeners };
}

describe('prerequisiteKey decode + accessor', () => {
  let originalFetch: typeof globalThis.fetch;
  let originalEventSource: typeof globalThis.EventSource;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    originalEventSource = globalThis.EventSource;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    globalThis.EventSource = originalEventSource;
    FeatureflipClient.resetForTesting();
  });

  it('decodes prerequisiteKey when present on evaluate response', async () => {
    globalThis.fetch = mockFetchRaw({
      flags: {
        'gated-flag': {
          value: false,
          variation: 'off',
          reason: 'prerequisite-failed',
          prerequisiteKey: 'parent-flag',
        },
      },
    });
    const { MockES } = mockEventSource();
    globalThis.EventSource = MockES as unknown as typeof EventSource;

    const client = FeatureflipClient.get({
      clientKey: 'test-key',
      baseUrl: 'http://localhost:8080',
    });
    await client.initialize();

    const detail = client.flagDetail('gated-flag');
    expect(detail).toBeDefined();
    expect(detail!.value).toBe(false);
    expect(detail!.variation).toBe('off');
    expect(detail!.reason).toBe('prerequisite-failed');
    expect(detail!.prerequisiteKey).toBe('parent-flag');

    client.close();
  });

  it('flagDetail returns prerequisiteKey === undefined when field is absent', async () => {
    globalThis.fetch = mockFetchRaw({
      flags: {
        'plain-flag': {
          value: true,
          variation: 'on',
          reason: 'fallthrough',
        },
      },
    });
    const { MockES } = mockEventSource();
    globalThis.EventSource = MockES as unknown as typeof EventSource;

    const client = FeatureflipClient.get({
      clientKey: 'test-key',
      baseUrl: 'http://localhost:8080',
    });
    await client.initialize();

    const detail = client.flagDetail('plain-flag');
    expect(detail).toBeDefined();
    expect(detail!.prerequisiteKey).toBeUndefined();
    expect('prerequisiteKey' in detail!).toBe(false);

    client.close();
  });

  it('flagDetail returns undefined for unknown flag', async () => {
    globalThis.fetch = mockFetchRaw({ flags: {} });
    const { MockES } = mockEventSource();
    globalThis.EventSource = MockES as unknown as typeof EventSource;

    const client = FeatureflipClient.get({
      clientKey: 'test-key',
      baseUrl: 'http://localhost:8080',
    });
    await client.initialize();

    expect(client.flagDetail('nope')).toBeUndefined();

    client.close();
  });

  it('decodes a mixed evaluate envelope with and without prerequisiteKey', async () => {
    globalThis.fetch = mockFetchRaw({
      flags: {
        'a': { value: true, variation: 'on', reason: 'fallthrough' },
        'b': {
          value: false,
          variation: 'off',
          reason: 'prerequisite-failed',
          prerequisiteKey: 'a',
        },
        'c': { value: 'hi', variation: 'v1', reason: 'rule-match:1' },
      },
    });
    const { MockES } = mockEventSource();
    globalThis.EventSource = MockES as unknown as typeof EventSource;

    const client = FeatureflipClient.get({
      clientKey: 'test-key',
      baseUrl: 'http://localhost:8080',
    });
    await client.initialize();

    expect(client.flagDetail('a')?.prerequisiteKey).toBeUndefined();
    expect(client.flagDetail('b')?.prerequisiteKey).toBe('a');
    expect(client.flagDetail('c')?.prerequisiteKey).toBeUndefined();

    client.close();
  });

  it('preserves prerequisiteKey across identify response', async () => {
    let callCount = 0;
    globalThis.fetch = vi.fn().mockImplementation(() => {
      callCount++;
      const body =
        callCount === 1
          ? {
              flags: {
                'gated': {
                  value: false,
                  variation: 'off',
                  reason: 'prerequisite-failed',
                  prerequisiteKey: 'parent',
                },
              },
            }
          : {
              flags: {
                'gated': {
                  value: true,
                  variation: 'on',
                  reason: 'fallthrough',
                },
              },
            };
      return Promise.resolve({ ok: true, json: () => Promise.resolve(body) });
    });
    const { MockES } = mockEventSource();
    globalThis.EventSource = MockES as unknown as typeof EventSource;

    const client = FeatureflipClient.get({
      clientKey: 'test-key',
      baseUrl: 'http://localhost:8080',
    });
    await client.initialize();
    expect(client.flagDetail('gated')?.prerequisiteKey).toBe('parent');

    await client.identify({ user_id: 'u2' });
    // After identify the parent passes, so prerequisiteKey is now absent
    expect(client.flagDetail('gated')?.prerequisiteKey).toBeUndefined();

    client.close();
  });

  it('preserves prerequisiteKey across SSE delta update', async () => {
    globalThis.fetch = mockFetchRaw({
      flags: {
        'gated': { value: true, variation: 'on', reason: 'fallthrough' },
      },
    });
    const { MockES, listeners } = mockEventSource();
    globalThis.EventSource = MockES as unknown as typeof EventSource;

    const client = FeatureflipClient.get({
      clientKey: 'test-key',
      baseUrl: 'http://localhost:8080',
      streaming: true,
    });
    await client.initialize();
    expect(client.flagDetail('gated')?.prerequisiteKey).toBeUndefined();

    listeners['flags-updated']?.(
      new MessageEvent('flags-updated', {
        data: JSON.stringify({
          flags: {
            'gated': {
              value: false,
              variation: 'off',
              reason: 'prerequisite-failed',
              prerequisiteKey: 'parent',
            },
          },
        }),
      }),
    );

    expect(client.flagDetail('gated')?.prerequisiteKey).toBe('parent');

    client.close();
  });

  it('FlagValue public type exposes prerequisiteKey as an optional field', () => {
    // Compile-time check: the public FlagValue type must declare the field.
    const a: FlagValue = { value: 1, variation: 'v', reason: 'r' };
    const b: FlagValue = {
      value: 1,
      variation: 'v',
      reason: 'r',
      prerequisiteKey: 'parent',
    };
    expect(a.prerequisiteKey).toBeUndefined();
    expect(b.prerequisiteKey).toBe('parent');
  });
});
