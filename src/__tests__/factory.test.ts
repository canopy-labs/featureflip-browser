import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { FeatureflipClient } from '../client';

function mockFetch(
  flags: Record<string, { value: unknown; variation: string; reason: string }> = {},
) {
  return vi.fn().mockResolvedValue({
    ok: true,
    json: () => Promise.resolve({ flags }),
  });
}

function mockEventSource() {
  const MockES = vi.fn().mockImplementation(function () {
    return {
      addEventListener: vi.fn(),
      close: vi.fn(),
      onerror: null as (() => void) | null,
    };
  });
  return MockES;
}

let keyCounter = 0;
function uniqueKey(name: string): string {
  keyCounter++;
  return `factory-${name}-${keyCounter}`;
}

describe('FeatureflipClient.get (factory)', () => {
  let originalFetch: typeof globalThis.fetch;
  let originalEventSource: typeof globalThis.EventSource;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    originalEventSource = globalThis.EventSource;
    globalThis.fetch = mockFetch({
      'test-flag': { value: true, variation: 'on', reason: 'match' },
    });
    globalThis.EventSource = mockEventSource() as unknown as typeof EventSource;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    globalThis.EventSource = originalEventSource;
    FeatureflipClient.resetForTesting();
  });

  it('returns a working client for a fresh client key', async () => {
    const key = uniqueKey('fresh');
    const client = FeatureflipClient.get({ clientKey: key, streaming: false });

    await client.initialize();
    expect(client.boolVariation('test-flag', false)).toBe(true);
    expect(FeatureflipClient.debugRefCount(key)).toBe(1);

    client.close();
    expect(FeatureflipClient.debugRefCount(key)).toBe(0);
  });

  it('second get() with same key constructs only ONE shared core', async () => {
    const key = uniqueKey('dedupe');
    const fetchMock = mockFetch({
      'test-flag': { value: true, variation: 'on', reason: 'match' },
    });
    globalThis.fetch = fetchMock;

    const h1 = FeatureflipClient.get({ clientKey: key, streaming: false });
    const h2 = FeatureflipClient.get({ clientKey: key, streaming: false });

    await h1.initialize();
    await h2.initialize();

    // Only one HTTP evaluation — the second get() reused the core.
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Handles are distinct instances but share state.
    expect(h1).not.toBe(h2);
    expect(h1.boolVariation('test-flag', false)).toBe(true);
    expect(h2.boolVariation('test-flag', false)).toBe(true);

    // Refcount is 2 (two handles outstanding).
    expect(FeatureflipClient.debugRefCount(key)).toBe(2);

    h1.close();
    h2.close();
  });

  it('get() with different client keys constructs independent cores', async () => {
    const keyA = uniqueKey('a');
    const keyB = uniqueKey('b');
    const fetchMock = mockFetch({});
    globalThis.fetch = fetchMock;

    const hA = FeatureflipClient.get({ clientKey: keyA, streaming: false });
    const hB = FeatureflipClient.get({ clientKey: keyB, streaming: false });

    await hA.initialize();
    await hB.initialize();

    // Two separate evaluations — independent cores.
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(FeatureflipClient.debugRefCount(keyA)).toBe(1);
    expect(FeatureflipClient.debugRefCount(keyB)).toBe(1);

    hA.close();
    hB.close();
  });

  it('after closing the only handle, next get() constructs a fresh core', async () => {
    const key = uniqueKey('recreate');
    const fetchMock = mockFetch({});
    globalThis.fetch = fetchMock;

    const h1 = FeatureflipClient.get({ clientKey: key, streaming: false });
    await h1.initialize();
    h1.close();

    expect(FeatureflipClient.debugRefCount(key)).toBe(0);

    const h2 = FeatureflipClient.get({ clientKey: key, streaming: false });
    await h2.initialize();

    // Two separate evaluations — new construction each time.
    expect(fetchMock).toHaveBeenCalledTimes(2);

    h2.close();
  });

  it('closing one of two handles leaves the other functional', async () => {
    const key = uniqueKey('shared');

    const h1 = FeatureflipClient.get({ clientKey: key, streaming: false });
    const h2 = FeatureflipClient.get({ clientKey: key, streaming: false });
    await h1.initialize();

    expect(FeatureflipClient.debugRefCount(key)).toBe(2);
    h1.close();
    expect(FeatureflipClient.debugRefCount(key)).toBe(1);

    // h2 still works.
    expect(h2.boolVariation('test-flag', false)).toBe(true);

    h2.close();
    expect(FeatureflipClient.debugRefCount(key)).toBe(0);
  });

  it('double-close on the same handle is idempotent', async () => {
    const key = uniqueKey('double');

    const h1 = FeatureflipClient.get({ clientKey: key, streaming: false });
    const h2 = FeatureflipClient.get({ clientKey: key, streaming: false });
    await h1.initialize();

    expect(FeatureflipClient.debugRefCount(key)).toBe(2);

    h1.close();
    h1.close(); // no-op
    h1.close(); // no-op

    // Only one decrement — h2 is still alive.
    expect(FeatureflipClient.debugRefCount(key)).toBe(1);

    h2.close();
    expect(FeatureflipClient.debugRefCount(key)).toBe(0);
  });

  it('32 concurrent get() calls for the same key share one shared core', async () => {
    const key = uniqueKey('concurrent');
    const fetchMock = mockFetch({});
    globalThis.fetch = fetchMock;

    const handles = await Promise.all(
      Array.from({ length: 32 }, () =>
        Promise.resolve(
          FeatureflipClient.get({ clientKey: key, streaming: false }),
        ),
      ),
    );

    await Promise.all(handles.map((h) => h.initialize()));

    // Only one HTTP evaluation — all 32 handles share one core.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(FeatureflipClient.debugRefCount(key)).toBe(32);

    for (const h of handles) {
      h.close();
    }
    expect(FeatureflipClient.debugRefCount(key)).toBe(0);
  });

  it('get() with different options on an existing key warns and reuses cache', async () => {
    const key = uniqueKey('warn');
    const fetchMock = mockFetch({});
    globalThis.fetch = fetchMock;
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const h1 = FeatureflipClient.get({
      clientKey: key,
      streaming: false,
      baseUrl: 'http://first.example',
    });
    await h1.initialize();

    // Different baseUrl — warn but reuse the cached core.
    const h2 = FeatureflipClient.get({
      clientKey: key,
      streaming: false,
      baseUrl: 'http://second.example',
    });

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('different options'),
    );
    // Still only one HTTP evaluation, proving h2 reused the existing core.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(FeatureflipClient.debugRefCount(key)).toBe(2);

    h1.close();
    h2.close();
    warnSpy.mockRestore();
  });

  it('get() without clientKey throws', () => {
    expect(() =>
      FeatureflipClient.get({ clientKey: '' }),
    ).toThrow('clientKey is required');
  });

  it('forTesting creates an independent client that is NOT in the factory cache', () => {
    const before = FeatureflipClient.debugLiveCoreCount;
    const client = FeatureflipClient.forTesting({ 'my-flag': true });
    expect(client.boolVariation('my-flag', false)).toBe(true);
    expect(FeatureflipClient.debugLiveCoreCount).toBe(before);
  });

  it('re-identifies the cached core when a second get() passes a different context', async () => {
    // Regression for #1205 (cached-core desync): without the factory-level
    // re-identify, a second caller's context is silently discarded because
    // the cached core retains the first caller's context — leaving the new
    // caller's flag evaluations targeted against the wrong user.
    const key = uniqueKey('context-rebind');
    const fetchMock = mockFetch();
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;

    const h1 = FeatureflipClient.get({
      clientKey: key,
      streaming: false,
      context: { userId: 'alice' },
    });
    await h1.initialize();

    // First evaluate carried alice's context.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const firstBody = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(firstBody.context).toEqual({ userId: 'alice' });

    // Second handle on same clientKey but a different user — must trigger a
    // re-identify against the server so bob's flags reflect bob, not alice.
    const h2 = FeatureflipClient.get({
      clientKey: key,
      streaming: false,
      context: { userId: 'bob' },
    });

    // Identify is fire-and-forget; let the microtask drain.
    await new Promise((r) => setTimeout(r, 0));

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const secondBody = JSON.parse(fetchMock.mock.calls[1][1].body as string);
    expect(secondBody.context).toEqual({ userId: 'bob' });

    h1.close();
    h2.close();
  });

  it('does not re-identify when the second get() passes an equivalent context', async () => {
    // Avoid wasting an HTTP round-trip when callers happen to construct
    // structurally-equal context objects.
    const key = uniqueKey('context-stable');
    const fetchMock = mockFetch();
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;

    const h1 = FeatureflipClient.get({
      clientKey: key,
      streaming: false,
      context: { userId: 'alice', plan: 'pro' },
    });
    await h1.initialize();

    const h2 = FeatureflipClient.get({
      clientKey: key,
      streaming: false,
      // Same keys + values, fresh object reference.
      context: { userId: 'alice', plan: 'pro' },
    });

    await new Promise((r) => setTimeout(r, 0));

    // Only the initial evaluate — no spurious identify.
    expect(fetchMock).toHaveBeenCalledTimes(1);

    h1.close();
    h2.close();
  });
});
