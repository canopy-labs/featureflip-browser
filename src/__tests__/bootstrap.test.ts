import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { FeatureflipClient } from '../client';
import { FLAG_CACHE_STORAGE_KEY, createLocalStorageFlagCache } from '../core/flag-cache';
import type { EvaluationEvent, FlagValue } from '../types';

type Flags = Record<string, FlagValue>;

/** A fetch whose evaluate responses resolve only when the test says so. */
function deferredFetch() {
  const pending: Array<(flags: Flags) => void> = [];
  const fetchMock = vi.fn().mockImplementation(
    (url: string) =>
      new Promise((resolve) => {
        if (url.endsWith('/v1/client/events')) {
          resolve({ ok: true, json: () => Promise.resolve({}) });
          return;
        }
        pending.push((flags) => resolve({ ok: true, json: () => Promise.resolve({ flags }) }));
      }),
  );
  return {
    fetchMock,
    respond(flags: Flags) {
      const next = pending.shift();
      if (!next) throw new Error('no request pending');
      next(flags);
    },
    evaluateCalls: () =>
      fetchMock.mock.calls.filter(([url]) => !String(url).endsWith('/v1/client/events')).length,
  };
}

function failingFetch() {
  return vi.fn().mockImplementation((url: string) =>
    String(url).endsWith('/v1/client/events')
      ? Promise.resolve({ ok: true, json: () => Promise.resolve({}) })
      : Promise.reject(new TypeError('Failed to fetch')),
  );
}

function stubEventSource() {
  const listeners: Record<string, (e: MessageEvent) => void> = {};
  const MockES = vi.fn().mockImplementation(function () {
    return {
      addEventListener: vi.fn((type: string, h: (e: MessageEvent) => void) => {
        listeners[type] = h;
      }),
      close: vi.fn(),
      onerror: null,
    };
  });
  globalThis.EventSource = MockES as unknown as typeof EventSource;
  return { MockES, listeners };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe('bootstrap', () => {
  let originalFetch: typeof globalThis.fetch;
  let originalEventSource: typeof globalThis.EventSource;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    originalEventSource = globalThis.EventSource;
    localStorage.clear();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    FeatureflipClient.resetForTesting();
    globalThis.fetch = originalFetch;
    globalThis.EventSource = originalEventSource;
    vi.restoreAllMocks();
  });

  describe('with an object of values', () => {
    it('serves the values before initialize(), with no network request', () => {
      const net = deferredFetch();
      globalThis.fetch = net.fetchMock;
      stubEventSource();

      const client = FeatureflipClient.get({
        clientKey: 'k',
        bootstrap: { banner: true, color: 'blue', limit: 3, cfg: { a: 1 } },
      });

      expect(client.isInitialized).toBe(true);
      expect(client.flagSource).toBe('bootstrap');
      expect(client.boolVariation('banner', false)).toBe(true);
      expect(client.stringVariation('color', 'red')).toBe('blue');
      expect(client.numberVariation('limit', 0)).toBe(3);
      expect(client.jsonVariation('cfg', {})).toEqual({ a: 1 });
      expect(net.fetchMock).not.toHaveBeenCalled();
    });

    it('initialize() resolves and fires ready before the server answers, then reconciles', async () => {
      const net = deferredFetch();
      globalThis.fetch = net.fetchMock;
      const { MockES } = stubEventSource();

      const client = FeatureflipClient.get({ clientKey: 'k', bootstrap: { banner: true, color: 'blue' } });
      const ready = vi.fn();
      const change = vi.fn();
      client.on('ready', ready);
      client.on('change', change);

      await client.initialize();
      expect(ready).toHaveBeenCalledTimes(1);
      expect(ready).toHaveBeenCalledWith({ source: 'bootstrap' });
      expect(net.evaluateCalls()).toBe(1);
      expect(MockES).not.toHaveBeenCalled();

      net.respond({
        banner: { value: false, variation: 'off', reason: 'fallthrough' },
        color: { value: 'blue', variation: 'b', reason: 'fallthrough' },
      });
      await flush();

      expect(client.flagSource).toBe('server');
      expect(client.boolVariation('banner', true)).toBe(false);
      expect(change).toHaveBeenCalledTimes(1);
      expect(change).toHaveBeenCalledWith({ banner: { oldValue: true, newValue: false } });
      // The stream opens after the evaluate, as it does without a bootstrap.
      expect(MockES).toHaveBeenCalledTimes(1);
      // ready fires once, not again for the server's values.
      expect(ready).toHaveBeenCalledTimes(1);
    });

    it('initialize({ waitForServer: true }) waits for the server response', async () => {
      const net = deferredFetch();
      globalThis.fetch = net.fetchMock;
      stubEventSource();

      const client = FeatureflipClient.get({ clientKey: 'k', bootstrap: { banner: true } });
      let settled = false;
      const p = client.initialize({ waitForServer: true }).then(() => {
        settled = true;
      });
      await flush();
      expect(settled).toBe(false);

      net.respond({ banner: { value: false, variation: 'off', reason: 'fallthrough' } });
      await p;
      expect(client.flagSource).toBe('server');
    });

    it('keeps serving the bootstrap values when the server is unreachable', async () => {
      globalThis.fetch = failingFetch();
      stubEventSource();

      const client = FeatureflipClient.get({ clientKey: 'k', bootstrap: { banner: true } });
      await client.initialize({ waitForServer: true });

      expect(client.flagSource).toBe('bootstrap');
      expect(client.boolVariation('banner', false)).toBe(true);
    });

    it('reports bootstrap reads, with no variation and a bootstrap reason for inspectors', () => {
      globalThis.fetch = deferredFetch().fetchMock;
      stubEventSource();
      const seen: EvaluationEvent[] = [];

      const client = FeatureflipClient.get({
        clientKey: 'k',
        bootstrap: { banner: true },
        inspectors: [(e) => seen.push(e)],
      });
      client.boolVariation('banner', false);

      expect(seen[0]).toMatchObject({ flagKey: 'banner', value: true, reason: 'bootstrap' });
      expect(seen[0].variationKey).toBeUndefined();
      expect(client.flagDetail('banner')).toEqual({ value: true, variation: '', reason: 'bootstrap' });
    });

    it('never writes the bootstrap values to localStorage', async () => {
      const net = deferredFetch();
      globalThis.fetch = net.fetchMock;
      stubEventSource();

      const client = FeatureflipClient.get({ clientKey: 'k', bootstrap: { banner: true } });
      await client.initialize();
      net.respond({ banner: { value: false, variation: 'off', reason: 'fallthrough' } });
      await flush();

      expect(localStorage.getItem(FLAG_CACHE_STORAGE_KEY)).toBeNull();
    });

    it('fires ready with source "server" when there is no bootstrap', async () => {
      const net = deferredFetch();
      globalThis.fetch = net.fetchMock;
      stubEventSource();

      const client = FeatureflipClient.get({ clientKey: 'k' });
      expect(client.isInitialized).toBe(false);
      expect(client.flagSource).toBe('none');
      const ready = vi.fn();
      client.on('ready', ready);
      const p = client.initialize();
      net.respond({ banner: { value: true, variation: 'on', reason: 'fallthrough' } });
      await p;

      expect(ready).toHaveBeenCalledWith({ source: 'server' });
    });

    it('fires ready with source "none" when there is no bootstrap and the evaluate fails', async () => {
      globalThis.fetch = failingFetch();
      stubEventSource();

      const client = FeatureflipClient.get({ clientKey: 'k' });
      const ready = vi.fn();
      client.on('ready', ready);
      await client.initialize();

      expect(ready).toHaveBeenCalledWith({ source: 'none' });
    });
  });

  describe("with 'localStorage'", () => {
    it('persists the server values and serves them on the next load before the network answers', async () => {
      const net = deferredFetch();
      globalThis.fetch = net.fetchMock;
      stubEventSource();

      const first = FeatureflipClient.get({ clientKey: 'k', context: { user_id: 'u1' }, bootstrap: 'localStorage' });
      expect(first.isInitialized).toBe(false);
      const p = first.initialize();
      net.respond({ banner: { value: true, variation: 'on', reason: 'fallthrough' } });
      await p;
      first.close();

      // "Next page load": a fresh core for the same key and context.
      const second = FeatureflipClient.get({ clientKey: 'k', context: { user_id: 'u1' }, bootstrap: 'localStorage' });
      expect(second.isInitialized).toBe(true);
      expect(second.flagSource).toBe('localStorage');
      expect(second.boolVariation('banner', false)).toBe(true);
      expect(second.flagDetail('banner')).toEqual({ value: true, variation: 'on', reason: 'persisted' });

      const ready = vi.fn();
      const change = vi.fn();
      second.on('ready', ready);
      second.on('change', change);
      await second.initialize();
      expect(ready).toHaveBeenCalledWith({ source: 'localStorage' });

      net.respond({ banner: { value: false, variation: 'off', reason: 'fallthrough' } });
      await flush();
      expect(second.boolVariation('banner', true)).toBe(false);
      expect(change).toHaveBeenCalledWith({ banner: { oldValue: true, newValue: false } });
      expect(createLocalStorageFlagCache().load('k', { user_id: 'u1' })).toEqual({
        banner: { value: false, variation: 'off', reason: 'persisted' },
      });
    });

    it('never serves values persisted for a different context', async () => {
      createLocalStorageFlagCache().save('k', { user_id: 'u1' }, {
        banner: { value: true, variation: 'on', reason: 'fallthrough' },
      });
      globalThis.fetch = deferredFetch().fetchMock;
      stubEventSource();

      const client = FeatureflipClient.get({ clientKey: 'k', context: { user_id: 'u2' }, bootstrap: 'localStorage' });
      expect(client.isInitialized).toBe(false);
      expect(client.boolVariation('banner', false)).toBe(false);
    });

    it('persists against the anonymous id, so a returning anonymous visitor gets their values', async () => {
      const net = deferredFetch();
      globalThis.fetch = net.fetchMock;
      stubEventSource();

      const first = FeatureflipClient.get({ clientKey: 'k', bootstrap: 'localStorage' });
      const p = first.initialize();
      net.respond({ banner: { value: true, variation: 'on', reason: 'fallthrough' } });
      await p;
      first.close();

      const second = FeatureflipClient.get({ clientKey: 'k', bootstrap: 'localStorage' });
      expect(second.boolVariation('banner', false)).toBe(true);
    });

    it('persists the identified context after identify(), not the previous one', async () => {
      const net = deferredFetch();
      globalThis.fetch = net.fetchMock;
      stubEventSource();

      const client = FeatureflipClient.get({ clientKey: 'k', context: { user_id: 'u1' }, bootstrap: 'localStorage' });
      const p = client.initialize();
      net.respond({ banner: { value: false, variation: 'off', reason: 'fallthrough' } });
      await p;

      const ident = client.identify({ user_id: 'u2' });
      net.respond({ banner: { value: true, variation: 'on', reason: 'rule-match:r1' } });
      await ident;

      const cache = createLocalStorageFlagCache();
      expect(cache.load('k', { user_id: 'u1' })?.banner.value).toBe(false);
      expect(cache.load('k', { user_id: 'u2' })?.banner.value).toBe(true);
    });

    it('never persists or serves the initial response for a context identify() has replaced', async () => {
      const net = deferredFetch();
      globalThis.fetch = net.fetchMock;
      stubEventSource();

      const client = FeatureflipClient.get({ clientKey: 'k', context: { user_id: 'a' }, bootstrap: 'localStorage' });
      const init = client.initialize(); // evaluate for a, in flight
      const ident = client.identify({ user_id: 'b' }); // identify for b, in flight

      net.respond({ banner: { value: true, variation: 'on', reason: 'rule-match:a-only' } }); // a's answer
      await init;
      expect(client.boolVariation('banner', false)).toBe(false);
      expect(createLocalStorageFlagCache().load('k', { user_id: 'b' })).toBeNull();

      net.respond({ banner: { value: false, variation: 'off', reason: 'fallthrough' } }); // b's answer
      await ident;
      expect(createLocalStorageFlagCache().load('k', { user_id: 'b' })?.banner.value).toBe(false);
      expect(createLocalStorageFlagCache().load('k', { user_id: 'a' })).toBeNull();
    });

    it('leaves one open stream when identify() overlaps the initial fetch', async () => {
      const net = deferredFetch();
      globalThis.fetch = net.fetchMock;
      const { MockES } = stubEventSource();

      const client = FeatureflipClient.get({ clientKey: 'k', context: { user_id: 'a' } });
      const init = client.initialize();
      const ident = client.identify({ user_id: 'b' });
      net.respond({});
      await init;
      net.respond({});
      await ident;

      const streams = MockES.mock.results.map((r) => r.value as { close: ReturnType<typeof vi.fn> });
      expect(streams.filter((es) => es.close.mock.calls.length === 0)).toHaveLength(1);
    });

    it('a superseded identify() neither applies, persists nor reverts over the newer one', async () => {
      const net = deferredFetch();
      globalThis.fetch = net.fetchMock;
      stubEventSource();

      const client = FeatureflipClient.get({ clientKey: 'k', context: { user_id: 'a' }, bootstrap: 'localStorage', streaming: false });
      const p = client.initialize();
      net.respond({});
      await p;

      const toB = client.identify({ user_id: 'b' });
      const toC = client.identify({ user_id: 'c' });
      net.respond({ banner: { value: true, variation: 'on', reason: 'rule-match:b-only' } }); // b's, late
      await toB;
      expect(client.boolVariation('banner', false)).toBe(false);
      expect(createLocalStorageFlagCache().load('k', { user_id: 'c' })).toBeNull();

      net.respond({ banner: { value: false, variation: 'off', reason: 'fallthrough' } });
      await toC;
      expect(createLocalStorageFlagCache().load('k', { user_id: 'c' })?.banner.value).toBe(false);
      expect(createLocalStorageFlagCache().load('k', { user_id: 'b' })).toBeNull();
    });

    it('persists SSE deltas and snapshots', async () => {
      const net = deferredFetch();
      globalThis.fetch = net.fetchMock;
      const { listeners } = stubEventSource();

      const client = FeatureflipClient.get({ clientKey: 'k', context: { user_id: 'u1' }, bootstrap: 'localStorage' });
      const p = client.initialize();
      net.respond({ banner: { value: false, variation: 'off', reason: 'fallthrough' } });
      await p;

      listeners['flags-updated']!(
        new MessageEvent('flags-updated', {
          data: JSON.stringify({ flags: { banner: { value: true, variation: 'on', reason: 'fallthrough' } } }),
        }),
      );

      expect(createLocalStorageFlagCache().load('k', { user_id: 'u1' })?.banner.value).toBe(true);
    });

    it('neither reads nor writes persisted values for a server key, and warns', async () => {
      createLocalStorageFlagCache().save('sdk_server_abc', { user_id: 'u1' }, {
        banner: { value: true, variation: 'on', reason: 'fallthrough' },
      });
      const before = localStorage.getItem(FLAG_CACHE_STORAGE_KEY);
      const net = deferredFetch();
      globalThis.fetch = net.fetchMock;
      stubEventSource();

      const client = FeatureflipClient.get({
        clientKey: 'sdk_server_abc',
        context: { user_id: 'u1' },
        bootstrap: 'localStorage',
      });
      expect(client.boolVariation('banner', false)).toBe(false);
      expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('server SDK key'));

      const p = client.initialize();
      net.respond({ banner: { value: false, variation: 'off', reason: 'fallthrough' } });
      await p;
      expect(localStorage.getItem(FLAG_CACHE_STORAGE_KEY)).toBe(before);
    });

    it('still works when localStorage throws', async () => {
      vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
        throw new Error('SecurityError');
      });
      vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
        throw new Error('QuotaExceededError');
      });
      const net = deferredFetch();
      globalThis.fetch = net.fetchMock;
      stubEventSource();

      const client = FeatureflipClient.get({ clientKey: 'k', bootstrap: 'localStorage' });
      const p = client.initialize();
      net.respond({ banner: { value: true, variation: 'on', reason: 'fallthrough' } });
      await p;
      expect(client.boolVariation('banner', false)).toBe(true);
    });
  });

  describe('forServerRender', () => {
    it('serves the bootstrap values, is not cached, and never touches the network', async () => {
      const net = deferredFetch();
      globalThis.fetch = net.fetchMock;
      stubEventSource();

      const a = FeatureflipClient.forServerRender({ clientKey: 'k', context: { user_id: 'a' }, bootstrap: { banner: true } });
      const b = FeatureflipClient.forServerRender({ clientKey: 'k', context: { user_id: 'b' }, bootstrap: { banner: false } });

      expect(a.boolVariation('banner', false)).toBe(true);
      expect(b.boolVariation('banner', true)).toBe(false);
      expect(FeatureflipClient.debugLiveCoreCount).toBe(0);

      await a.initialize();
      await a.identify({ user_id: 'c' });
      a.close();
      b.close();
      expect(net.fetchMock).not.toHaveBeenCalled();
    });

    it('is initialized only when it has bootstrap values, matching the browser-side client', () => {
      expect(FeatureflipClient.forServerRender({ clientKey: 'k', bootstrap: { f: 1 } }).isInitialized).toBe(true);
      expect(FeatureflipClient.forServerRender({ clientKey: 'k' }).isInitialized).toBe(false);
      expect(FeatureflipClient.forServerRender({ clientKey: 'k', bootstrap: 'localStorage' }).isInitialized).toBe(false);
    });
  });

  it('a repeat get() with a different bootstrap does not warn about differing options', () => {
    globalThis.fetch = deferredFetch().fetchMock;
    stubEventSource();
    const a = FeatureflipClient.get({ clientKey: 'k', bootstrap: { banner: true } });
    const b = FeatureflipClient.get({ clientKey: 'k', bootstrap: { banner: false } });
    expect(console.warn).not.toHaveBeenCalled();
    a.close();
    b.close();
  });
});
