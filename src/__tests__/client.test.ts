import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { FeatureflipClient } from '../client';

function mockFetch(flags: Record<string, { value: unknown; variation: string; reason: string }>) {
  return vi.fn().mockResolvedValue({
    ok: true,
    json: () => Promise.resolve({ flags }),
  });
}

function mockEventSource() {
  const listeners: Record<string, ((event: MessageEvent) => void)> = {};
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

describe('FeatureflipClient', () => {
  let originalFetch: typeof globalThis.fetch;
  let originalEventSource: typeof globalThis.EventSource;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    originalEventSource = globalThis.EventSource;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    globalThis.EventSource = originalEventSource;
  });

  it('throws if no clientKey provided', () => {
    expect(() => new FeatureflipClient({ clientKey: '' })).toThrow('clientKey is required');
  });

  it('returns default value before initialization', () => {
    const client = new FeatureflipClient({ clientKey: 'test-key', streaming: false });
    expect(client.boolVariation('flag', false)).toBe(false);
    expect(client.boolVariation('flag', true)).toBe(true);
    expect(client.stringVariation('flag', 'default')).toBe('default');
    expect(client.numberVariation('flag', 42)).toBe(42);
    expect(client.jsonVariation('flag', { a: 1 })).toEqual({ a: 1 });
  });

  it('returns evaluated value after initialization', async () => {
    const flags = {
      'bool-flag': { value: true, variation: 'on', reason: 'match' },
      'string-flag': { value: 'hello', variation: 'v1', reason: 'match' },
      'number-flag': { value: 99, variation: 'v2', reason: 'default' },
      'json-flag': { value: { nested: true }, variation: 'v1', reason: 'match' },
    };

    globalThis.fetch = mockFetch(flags);
    const { MockES } = mockEventSource();
    globalThis.EventSource = MockES as unknown as typeof EventSource;

    const client = new FeatureflipClient({
      clientKey: 'test-key',
      baseUrl: 'http://localhost:8080',
    });

    await client.initialize();

    expect(client.boolVariation('bool-flag', false)).toBe(true);
    expect(client.stringVariation('string-flag', 'default')).toBe('hello');
    expect(client.numberVariation('number-flag', 0)).toBe(99);
    expect(client.jsonVariation('json-flag', {})).toEqual({ nested: true });

    client.close();
  });

  it('forTesting returns hardcoded values', () => {
    const client = FeatureflipClient.forTesting({
      'flag-a': true,
      'flag-b': 'test-value',
      'flag-c': 42,
    });

    expect(client.boolVariation('flag-a', false)).toBe(true);
    expect(client.stringVariation('flag-b', 'default')).toBe('test-value');
    expect(client.numberVariation('flag-c', 0)).toBe(42);
    expect(client.boolVariation('unknown', false)).toBe(false);
  });

  it('emits ready event on initialization', async () => {
    globalThis.fetch = mockFetch({});
    const { MockES } = mockEventSource();
    globalThis.EventSource = MockES as unknown as typeof EventSource;

    const client = new FeatureflipClient({
      clientKey: 'test-key',
      baseUrl: 'http://localhost:8080',
    });

    const readyHandler = vi.fn();
    client.on('ready', readyHandler);

    await client.initialize();

    expect(readyHandler).toHaveBeenCalledOnce();

    client.close();
  });

  it('identify updates flag values and emits change', async () => {
    const initialFlags = {
      'flag-a': { value: false, variation: 'off', reason: 'default' },
      'flag-b': { value: 'old', variation: 'v1', reason: 'default' },
    };

    const updatedFlags = {
      'flag-a': { value: true, variation: 'on', reason: 'match' },
      'flag-b': { value: 'new', variation: 'v2', reason: 'match' },
    };

    let callCount = 0;
    globalThis.fetch = vi.fn().mockImplementation(() => {
      callCount++;
      const flags = callCount === 1 ? initialFlags : updatedFlags;
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ flags }),
      });
    });

    const client = new FeatureflipClient({
      clientKey: 'test-key',
      baseUrl: 'http://localhost:8080',
      streaming: false,
    });

    await client.initialize();

    expect(client.boolVariation('flag-a', true)).toBe(false);

    const changeHandler = vi.fn();
    client.on('change', changeHandler);

    await client.identify({ user_id: 'user-123' });

    expect(client.boolVariation('flag-a', false)).toBe(true);
    expect(client.stringVariation('flag-b', 'default')).toBe('new');

    expect(changeHandler).toHaveBeenCalledOnce();
    expect(changeHandler).toHaveBeenCalledWith({
      'flag-a': { oldValue: false, newValue: true },
      'flag-b': { oldValue: 'old', newValue: 'new' },
    });
  });

  it('stringVariation returns correct type', async () => {
    const flags = {
      'color': { value: 'blue', variation: 'v1', reason: 'match' },
      'bool-as-string': { value: true, variation: 'v1', reason: 'match' },
    };

    globalThis.fetch = mockFetch(flags);

    const client = new FeatureflipClient({
      clientKey: 'test-key',
      baseUrl: 'http://localhost:8080',
      streaming: false,
    });

    await client.initialize();

    expect(client.stringVariation('color', 'red')).toBe('blue');
    // Wrong type should return default
    expect(client.stringVariation('bool-as-string', 'fallback')).toBe('fallback');
  });

  it('numberVariation returns correct type', async () => {
    const flags = {
      'count': { value: 7, variation: 'v1', reason: 'match' },
      'string-as-number': { value: 'not-a-number', variation: 'v1', reason: 'match' },
    };

    globalThis.fetch = mockFetch(flags);

    const client = new FeatureflipClient({
      clientKey: 'test-key',
      baseUrl: 'http://localhost:8080',
      streaming: false,
    });

    await client.initialize();

    expect(client.numberVariation('count', 0)).toBe(7);
    // Wrong type should return default
    expect(client.numberVariation('string-as-number', 99)).toBe(99);
  });

  it('does not emit change when identify returns same values', async () => {
    const flags = {
      'flag-a': { value: true, variation: 'on', reason: 'match' },
    };

    globalThis.fetch = mockFetch(flags);

    const client = new FeatureflipClient({
      clientKey: 'test-key',
      baseUrl: 'http://localhost:8080',
      streaming: false,
    });

    await client.initialize();

    const changeHandler = vi.fn();
    client.on('change', changeHandler);

    await client.identify({ user_id: 'user-123' });

    expect(changeHandler).not.toHaveBeenCalled();
  });

  it('identify reverts context and emits error on fetch failure', async () => {
    const initialFlags = {
      'flag-a': { value: false, variation: 'off', reason: 'default' },
    };

    let callCount = 0;
    globalThis.fetch = vi.fn().mockImplementation(() => {
      callCount++;
      if (callCount === 1) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ flags: initialFlags }),
        });
      }
      // Second call (identify) fails
      return Promise.reject(new Error('Network error'));
    });

    const { MockES, listeners } = mockEventSource();
    globalThis.EventSource = MockES as unknown as typeof EventSource;

    const client = new FeatureflipClient({
      clientKey: 'test-key',
      baseUrl: 'http://localhost:8080',
      streaming: true,
      context: { user_id: 'user-1' },
    });

    await client.initialize();

    const errorHandler = vi.fn();
    client.on('error', errorHandler);

    // identify should reject and revert context
    await expect(client.identify({ user_id: 'user-2' })).rejects.toThrow('Network error');

    // Error should be emitted
    expect(errorHandler).toHaveBeenCalledOnce();

    // Flags should remain unchanged (old context's flags)
    expect(client.boolVariation('flag-a', true)).toBe(false);

    // SSE should be re-established with the original context
    // (identify closed the old stream, so a new one should be created)
    expect(MockES.mock.calls.length).toBe(2); // initial + re-established

    client.close();
  });

  it('identify reconnects streaming connection with new context', async () => {
    const initialFlags = {
      'flag-a': { value: false, variation: 'off', reason: 'default' },
    };

    const updatedFlags = {
      'flag-a': { value: true, variation: 'on', reason: 'match' },
    };

    let callCount = 0;
    globalThis.fetch = vi.fn().mockImplementation(() => {
      callCount++;
      const flags = callCount === 1 ? initialFlags : updatedFlags;
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ flags }),
      });
    });

    const mockCloses: ReturnType<typeof vi.fn>[] = [];
    const constructedUrls: string[] = [];
    const MockES = vi.fn().mockImplementation(function (url: string) {
      constructedUrls.push(url);
      const closeFn = vi.fn();
      mockCloses.push(closeFn);
      return {
        addEventListener: vi.fn(),
        close: closeFn,
        onerror: null,
      };
    });
    globalThis.EventSource = MockES as unknown as typeof EventSource;

    // Track that the old stream is closed before the HTTP identify call
    let streamClosedBeforeFetch = false;
    const fetchMock = globalThis.fetch as ReturnType<typeof vi.fn>;
    const originalImpl = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation((...args: unknown[]) => {
      if (mockCloses[0]?.mock.calls.length > 0) {
        streamClosedBeforeFetch = true;
      }
      return originalImpl(...args);
    });

    const client = new FeatureflipClient({
      clientKey: 'test-key',
      baseUrl: 'http://localhost:8080',
      streaming: true,
      context: { user_id: 'user-1' },
    });

    await client.initialize();

    expect(constructedUrls).toHaveLength(1);

    await client.identify({ user_id: 'user-2' });

    // Old stream must be closed before the HTTP call to prevent stale updates
    expect(streamClosedBeforeFetch).toBe(true);
    // New connection should be created with new context
    expect(constructedUrls).toHaveLength(2);
    expect(constructedUrls[1]).not.toBe(constructedUrls[0]);

    client.close();
  });

  it('second initialize() returns same promise and does not open duplicate SSE', async () => {
    globalThis.fetch = mockFetch({
      'flag-a': { value: true, variation: 'on', reason: 'match' },
    });

    const constructedCount = { value: 0 };
    const MockES = vi.fn().mockImplementation(function () {
      constructedCount.value++;
      return {
        addEventListener: vi.fn(),
        close: vi.fn(),
        onerror: null,
      };
    });
    globalThis.EventSource = MockES as unknown as typeof EventSource;

    const client = new FeatureflipClient({
      clientKey: 'test-key',
      baseUrl: 'http://localhost:8080',
      streaming: true,
    });

    const p1 = client.initialize();
    const p2 = client.initialize();

    expect(p1).toBe(p2);

    await p1;

    // Only one SSE connection should be opened
    expect(constructedCount.value).toBe(1);
    // Only one fetch call
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);

    client.close();
  });

  it('initialize() is a no-op after already initialized', async () => {
    globalThis.fetch = mockFetch({});

    const client = new FeatureflipClient({
      clientKey: 'test-key',
      baseUrl: 'http://localhost:8080',
      streaming: false,
    });

    await client.initialize();

    // Second call after completion should be a no-op
    await client.initialize();

    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
  });

  it('close() during in-flight initialize prevents SSE creation', async () => {
    let fetchResolve: (value: unknown) => void;
    globalThis.fetch = vi.fn().mockImplementation(
      () =>
        new Promise((resolve) => {
          fetchResolve = resolve;
        }),
    );

    const MockES = vi.fn().mockImplementation(function () {
      return {
        addEventListener: vi.fn(),
        close: vi.fn(),
        onerror: null,
      };
    });
    globalThis.EventSource = MockES as unknown as typeof EventSource;

    const client = new FeatureflipClient({
      clientKey: 'test-key',
      baseUrl: 'http://localhost:8080',
      streaming: true,
    });

    const initPromise = client.initialize();

    // Close while fetch is still in-flight
    client.close();

    // Now resolve the fetch
    fetchResolve!({
      ok: true,
      json: () => Promise.resolve({ flags: {} }),
    });

    await initPromise;

    // No SSE connection should have been created
    expect(MockES.mock.calls.length).toBe(0);
  });

  it('off removes event handler', async () => {
    globalThis.fetch = mockFetch({});

    const client = new FeatureflipClient({
      clientKey: 'test-key',
      baseUrl: 'http://localhost:8080',
      streaming: false,
    });

    const readyHandler = vi.fn();
    client.on('ready', readyHandler);
    client.off('ready', readyHandler);

    await client.initialize();

    expect(readyHandler).not.toHaveBeenCalled();
  });

  it('sends correct headers and body in evaluate request', async () => {
    const fetchMock = mockFetch({});
    globalThis.fetch = fetchMock;

    const client = new FeatureflipClient({
      clientKey: 'my-sdk-key',
      baseUrl: 'http://localhost:8080',
      context: { user_id: 'abc' },
      streaming: false,
    });

    await client.initialize();

    expect(fetchMock).toHaveBeenCalledWith(
      'http://localhost:8080/v1/client/evaluate',
      expect.objectContaining({
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'my-sdk-key',
        },
        body: JSON.stringify({ context: { user_id: 'abc' } }),
      }),
    );
  });

  it('handles SSE flag updates', async () => {
    const initialFlags = {
      'flag-a': { value: false, variation: 'off', reason: 'default' },
    };

    globalThis.fetch = mockFetch(initialFlags);

    const listeners: Record<string, (event: MessageEvent) => void> = {};
    const mockClose = vi.fn();
    const MockES = vi.fn().mockImplementation(function () {
      return {
        addEventListener: vi.fn((type: string, handler: (event: MessageEvent) => void) => {
          listeners[type] = handler;
        }),
        close: mockClose,
        onerror: null,
      };
    });
    globalThis.EventSource = MockES as unknown as typeof EventSource;

    const client = new FeatureflipClient({
      clientKey: 'test-key',
      baseUrl: 'http://localhost:8080',
      streaming: true,
    });

    const changeHandler = vi.fn();
    client.on('change', changeHandler);

    await client.initialize();

    // Simulate SSE flag update
    const updatedFlags = {
      'flag-a': { value: true, variation: 'on', reason: 'match' },
    };
    listeners['flags-updated']?.(
      new MessageEvent('flags-updated', {
        data: JSON.stringify({ flags: updatedFlags }),
      }),
    );

    expect(client.boolVariation('flag-a', false)).toBe(true);
    expect(changeHandler).toHaveBeenCalledWith({
      'flag-a': { oldValue: false, newValue: true },
    });

    client.close();
  });

  it('does not remove flag when value is null but reason is not FLAG_REMOVED', async () => {
    const initialFlags = {
      'json-flag': { value: { some: 'data' }, variation: 'v1', reason: 'match' },
    };

    globalThis.fetch = mockFetch(initialFlags);

    const listeners: Record<string, (event: MessageEvent) => void> = {};
    const MockES = vi.fn().mockImplementation(function () {
      return {
        addEventListener: vi.fn((type: string, handler: (event: MessageEvent) => void) => {
          listeners[type] = handler;
        }),
        close: vi.fn(),
        onerror: null,
      };
    });
    globalThis.EventSource = MockES as unknown as typeof EventSource;

    const client = new FeatureflipClient({
      clientKey: 'test-key',
      baseUrl: 'http://localhost:8080',
      streaming: true,
    });

    await client.initialize();

    // SSE update with null value but NOT a removal — should update, not delete
    listeners['flags-updated']?.(
      new MessageEvent('flags-updated', {
        data: JSON.stringify({
          flags: {
            'json-flag': { value: null, variation: 'v2', reason: 'match' },
          },
        }),
      }),
    );

    // Flag should still exist with null value, not be removed
    expect(client.jsonVariation('json-flag', 'default')).toBeNull();

    client.close();
  });

  it('removes flag when both reason is FLAG_REMOVED and value is null', async () => {
    const initialFlags = {
      'flag-a': { value: true, variation: 'on', reason: 'match' },
    };

    globalThis.fetch = mockFetch(initialFlags);

    const listeners: Record<string, (event: MessageEvent) => void> = {};
    const MockES = vi.fn().mockImplementation(function () {
      return {
        addEventListener: vi.fn((type: string, handler: (event: MessageEvent) => void) => {
          listeners[type] = handler;
        }),
        close: vi.fn(),
        onerror: null,
      };
    });
    globalThis.EventSource = MockES as unknown as typeof EventSource;

    const client = new FeatureflipClient({
      clientKey: 'test-key',
      baseUrl: 'http://localhost:8080',
      streaming: true,
    });

    const changeHandler = vi.fn();
    client.on('change', changeHandler);

    await client.initialize();

    // SSE removal with both FLAG_REMOVED reason AND null value
    listeners['flags-updated']?.(
      new MessageEvent('flags-updated', {
        data: JSON.stringify({
          flags: {
            'flag-a': { value: null, variation: '', reason: 'FLAG_REMOVED' },
          },
        }),
      }),
    );

    // Flag should be removed — returns default
    expect(client.boolVariation('flag-a', false)).toBe(false);
    expect(changeHandler).toHaveBeenCalledWith({
      'flag-a': { oldValue: true, newValue: undefined },
    });

    client.close();
  });

  it('does not send X-Connection-Id on identify because stream is closed first', async () => {
    globalThis.fetch = mockFetch({});

    const listeners: Record<string, (event: MessageEvent) => void> = {};
    const MockES = vi.fn().mockImplementation(function () {
      return {
        addEventListener: vi.fn((type: string, handler: (event: MessageEvent) => void) => {
          listeners[type] = handler;
        }),
        close: vi.fn(),
        onerror: null,
      };
    });
    globalThis.EventSource = MockES as unknown as typeof EventSource;

    const client = new FeatureflipClient({
      clientKey: 'test-key',
      baseUrl: 'http://localhost:8080',
      streaming: true,
    });

    await client.initialize();

    // Simulate connection-ready event — connectionId is stored on stream
    listeners['connection-ready']?.(
      new MessageEvent('connection-ready', {
        data: JSON.stringify({ connectionId: 'abc-123-def' }),
      }),
    );

    // Replace fetch for identify call
    const fetchMock = vi.fn().mockImplementation(() => {
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ flags: {} }),
      });
    });
    globalThis.fetch = fetchMock;

    // Browser SDK closes stream before calling identify, so X-Connection-Id is never sent
    await client.identify({ user_id: 'user-2' });

    const identifyCall = fetchMock.mock.calls[0];
    const headers = identifyCall[1].headers;
    expect(headers['X-Connection-Id']).toBeUndefined();

    client.close();
  });
});
