import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { FeatureflipClient } from '../client';

interface FetchCall {
  url: string;
  body: { context: Record<string, unknown> } | undefined;
}

function recordingFetch(calls: FetchCall[], flags: Record<string, unknown> = {}) {
  return vi.fn().mockImplementation((url: string, init?: RequestInit) => {
    calls.push({
      url,
      body: init?.body ? JSON.parse(init.body as string) : undefined,
    });
    return Promise.resolve({ ok: true, json: () => Promise.resolve({ flags }) });
  });
}

function mockEventSource(urls: string[]) {
  return vi.fn().mockImplementation(function (url: string) {
    urls.push(url);
    return { addEventListener: vi.fn(), close: vi.fn(), onerror: null };
  });
}

function evalContext(calls: FetchCall[]): Record<string, unknown> {
  const call = calls.find((c) => c.url.includes('/v1/client/evaluate'));
  expect(call).toBeDefined();
  return call!.body!.context;
}

describe('SharedFeatureflipCore anonymous key wiring', () => {
  let originalFetch: typeof globalThis.fetch;
  let originalEventSource: typeof globalThis.EventSource;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    originalEventSource = globalThis.EventSource;
    globalThis.localStorage.clear();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    globalThis.EventSource = originalEventSource;
    FeatureflipClient.resetForTesting();
    globalThis.localStorage.clear();
  });

  it('injects a generated user_id into the evaluate request for an anonymous caller', async () => {
    const calls: FetchCall[] = [];
    globalThis.fetch = recordingFetch(calls);

    const client = FeatureflipClient.get({
      clientKey: 'k',
      baseUrl: 'http://x',
      context: { plan: 'pro' },
      streaming: false,
    });
    await client.initialize();

    const ctx = evalContext(calls);
    expect(typeof ctx.user_id).toBe('string');
    expect((ctx.user_id as string).length).toBeGreaterThan(0);
    expect(ctx.plan).toBe('pro');

    client.close();
  });

  it('reuses the same persisted anonymous user_id across sessions', async () => {
    const calls1: FetchCall[] = [];
    globalThis.fetch = recordingFetch(calls1);
    const c1 = FeatureflipClient.get({ clientKey: 'k', baseUrl: 'http://x', context: {}, streaming: false });
    await c1.initialize();
    const id1 = evalContext(calls1).user_id;
    c1.close();
    FeatureflipClient.resetForTesting();

    // Simulate a fresh session: new core, same backing localStorage.
    const calls2: FetchCall[] = [];
    globalThis.fetch = recordingFetch(calls2);
    const c2 = FeatureflipClient.get({ clientKey: 'k', baseUrl: 'http://x', context: {}, streaming: false });
    await c2.initialize();
    const id2 = evalContext(calls2).user_id;
    c2.close();

    expect(typeof id1).toBe('string');
    expect(id2).toBe(id1);
  });

  it('does not inject when the caller provides a real user_id', async () => {
    const calls: FetchCall[] = [];
    globalThis.fetch = recordingFetch(calls);

    const client = FeatureflipClient.get({
      clientKey: 'k',
      baseUrl: 'http://x',
      context: { user_id: 'real-1' },
      streaming: false,
    });
    await client.initialize();

    expect(evalContext(calls).user_id).toBe('real-1');
    expect(globalThis.localStorage.getItem('featureflip.anonymous_id')).toBeNull();

    client.close();
  });

  it('carries the injected user_id on the SSE stream URL (no flicker on refresh)', async () => {
    const calls: FetchCall[] = [];
    globalThis.fetch = recordingFetch(calls);
    const urls: string[] = [];
    globalThis.EventSource = mockEventSource(urls) as unknown as typeof EventSource;

    const client = FeatureflipClient.get({ clientKey: 'k', baseUrl: 'http://x', context: {}, streaming: true });
    await client.initialize();

    expect(urls.length).toBeGreaterThan(0);
    const encoded = new URL(urls[0]).searchParams.get('context')!;
    const decoded = JSON.parse(
      new TextDecoder().decode(Uint8Array.from(atob(encoded), (ch) => ch.charCodeAt(0))),
    ) as Record<string, unknown>;
    expect(typeof decoded.user_id).toBe('string');
    expect((decoded.user_id as string).length).toBeGreaterThan(0);

    // The SSE stream and the evaluate request must use the SAME anonymous id.
    expect(decoded.user_id).toBe(evalContext(calls).user_id);

    client.close();
  });

  it('does not re-identify on a repeat get() with the same anonymous context', async () => {
    const calls: FetchCall[] = [];
    globalThis.fetch = recordingFetch(calls);

    const c1 = FeatureflipClient.get({ clientKey: 'k', baseUrl: 'http://x', context: { plan: 'pro' }, streaming: false });
    await c1.initialize();

    // A second handle with the same caller context must NOT trigger identify —
    // the stored context stays raw, so contextsEqual holds.
    const c2 = FeatureflipClient.get({ clientKey: 'k', baseUrl: 'http://x', context: { plan: 'pro' }, streaming: false });
    await Promise.resolve(); // let any erroneous fire-and-forget identify settle

    expect(calls.filter((c) => c.url.includes('/v1/client/identify'))).toHaveLength(0);

    c1.close();
    c2.close();
  });
});
