import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { FeatureflipClient } from '../client';

const FLAGS = {
  'bool-flag': { value: true, variation: 'on', reason: 'fallthrough' },
  'str-flag': { value: 'hi', variation: 'v1', reason: 'fallthrough' },
  'num-flag': { value: 3, variation: 'n', reason: 'fallthrough' },
  'json-flag': { value: { a: 1 }, variation: 'j', reason: 'fallthrough' },
  'unread-flag': { value: true, variation: 'on', reason: 'fallthrough' },
};

function routedFetch() {
  return vi.fn(async (url: string, _init?: RequestInit) => {
    if (url.endsWith('/v1/client/events')) return { ok: true, status: 202, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => ({ flags: FLAGS }) };
  });
}

type FetchMock = ReturnType<typeof routedFetch>;

const callsTo = (m: FetchMock, path: string) =>
  m.mock.calls.filter(([url]) => String(url).endsWith(path));

function sentEvents(m: FetchMock): Array<{ flagKey: string; variation?: string; userId?: string; type: string }> {
  return callsTo(m, '/v1/client/events').flatMap(([, init]) => JSON.parse((init as RequestInit).body as string).events);
}

let n = 0;
const uniqueKey = () => `read-reporting-${++n}`;

describe('read reporting', () => {
  let originalFetch: typeof globalThis.fetch;
  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
    FeatureflipClient.resetForTesting();
  });

  it('sends the reports-evaluations header on evaluate and identify by default', async () => {
    const fetchMock = routedFetch();
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const client = FeatureflipClient.get({ clientKey: uniqueKey(), baseUrl: 'http://x', streaming: false, context: { user_id: 'u1' } });
    await client.initialize();
    await client.identify({ user_id: 'u2' });

    for (const path of ['/v1/client/evaluate', '/v1/client/identify']) {
      const [[, init]] = callsTo(fetchMock, path);
      expect((init as RequestInit).headers).toMatchObject({ 'X-Featureflip-Reports-Evaluations': '1' });
    }
    client.close();
  });

  it('reports each read flag once, with its variation and user, and never the unread ones', async () => {
    const fetchMock = routedFetch();
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const client = FeatureflipClient.get({ clientKey: uniqueKey(), baseUrl: 'http://x', streaming: false, context: { user_id: 'u1' } });
    await client.initialize();

    for (let i = 0; i < 50; i++) {
      client.boolVariation('bool-flag', false);
      client.stringVariation('str-flag', '');
      client.numberVariation('num-flag', 0);
      client.jsonVariation('json-flag', {});
    }
    client.close(); // final flush

    await vi.waitFor(() => expect(callsTo(fetchMock, '/v1/client/events')).toHaveLength(1));
    const events = sentEvents(fetchMock);
    expect(events.map((e) => [e.type, e.flagKey, e.variation, e.userId]).sort()).toEqual([
      ['Evaluation', 'bool-flag', 'on', 'u1'],
      ['Evaluation', 'json-flag', 'j', 'u1'],
      ['Evaluation', 'num-flag', 'n', 'u1'],
      ['Evaluation', 'str-flag', 'v1', 'u1'],
    ]);
  });

  it('flagDetail counts as a read', async () => {
    const fetchMock = routedFetch();
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const client = FeatureflipClient.get({ clientKey: uniqueKey(), baseUrl: 'http://x', streaming: false, context: { user_id: 'u1' } });
    await client.initialize();
    client.flagDetail('str-flag');
    client.close();
    await vi.waitFor(() => expect(sentEvents(fetchMock).map((e) => e.flagKey)).toEqual(['str-flag']));
  });

  it('records a read of a flag the snapshot does not have, with no variation', async () => {
    const fetchMock = routedFetch();
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const client = FeatureflipClient.get({ clientKey: uniqueKey(), baseUrl: 'http://x', streaming: false, context: { user_id: 'u1' } });
    await client.initialize();
    client.boolVariation('not-served', false);
    client.close();
    await vi.waitFor(() => expect(sentEvents(fetchMock)).toHaveLength(1));
    const [event] = sentEvents(fetchMock);
    expect(event.flagKey).toBe('not-served');
    expect(event).not.toHaveProperty('variation');
  });

  it('records reads made before initialize() resolves, without sending before it starts', async () => {
    const fetchMock = routedFetch();
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const client = FeatureflipClient.get({ clientKey: uniqueKey(), baseUrl: 'http://x', streaming: false, context: { user_id: 'u1' } });
    client.boolVariation('bool-flag', false); // before initialize: default, no variation
    expect(fetchMock).not.toHaveBeenCalled();
    await client.initialize();
    client.close();
    await vi.waitFor(() => expect(sentEvents(fetchMock).map((e) => [e.flagKey, e.variation])).toEqual([['bool-flag', undefined]]));
  });

  it('a read after identify() switches user is a new read', async () => {
    const fetchMock = routedFetch();
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const client = FeatureflipClient.get({ clientKey: uniqueKey(), baseUrl: 'http://x', streaming: false, context: { user_id: 'u1' } });
    await client.initialize();
    client.boolVariation('bool-flag', false);
    await client.identify({ user_id: 'u2' });
    client.boolVariation('bool-flag', false);
    client.close();
    await vi.waitFor(() =>
      expect(sentEvents(fetchMock).map((e) => e.userId).sort()).toEqual(['u1', 'u2']),
    );
  });

  it('uses the persisted anonymous id as userId when the context has none', async () => {
    const fetchMock = routedFetch();
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const client = FeatureflipClient.get({ clientKey: uniqueKey(), baseUrl: 'http://x', streaming: false });
    await client.initialize();
    client.boolVariation('bool-flag', false);
    client.close();
    const evaluateBody = JSON.parse((callsTo(fetchMock, '/v1/client/evaluate')[0][1] as RequestInit).body as string);
    await vi.waitFor(() => expect(sentEvents(fetchMock)).toHaveLength(1));
    expect(sentEvents(fetchMock)[0].userId).toBe(evaluateBody.context.user_id);
    expect(typeof evaluateBody.context.user_id).toBe('string');
  });

  it('sendEvaluationEvents: false sends neither events nor the header', async () => {
    const fetchMock = routedFetch();
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const client = FeatureflipClient.get({
      clientKey: uniqueKey(), baseUrl: 'http://x', streaming: false, context: { user_id: 'u1' }, sendEvaluationEvents: false,
    });
    await client.initialize();
    await client.identify({ user_id: 'u2' });
    client.boolVariation('bool-flag', false);
    client.close();
    await new Promise((r) => setTimeout(r, 0));

    expect(callsTo(fetchMock, '/v1/client/events')).toHaveLength(0);
    for (const path of ['/v1/client/evaluate', '/v1/client/identify']) {
      const [[, init]] = callsTo(fetchMock, path);
      expect((init as RequestInit).headers).not.toHaveProperty('X-Featureflip-Reports-Evaluations');
    }
  });

  it('a second get() with a different sendEvaluationEvents warns and keeps the cached setting', async () => {
    const fetchMock = routedFetch();
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const key = uniqueKey();
    const a = FeatureflipClient.get({ clientKey: key, baseUrl: 'http://x', streaming: false });
    const b = FeatureflipClient.get({ clientKey: key, baseUrl: 'http://x', streaming: false, sendEvaluationEvents: false });
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('different options'));
    await b.initialize();
    const [[, init]] = callsTo(fetchMock, '/v1/client/evaluate');
    expect((init as RequestInit).headers).toMatchObject({ 'X-Featureflip-Reports-Evaluations': '1' });
    a.close();
    b.close();
    warnSpy.mockRestore();
  });

  it('forTesting clients never touch the network', async () => {
    const fetchMock = routedFetch();
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const client = FeatureflipClient.forTesting({ 'bool-flag': true });
    client.boolVariation('bool-flag', false);
    client.close();
    await new Promise((r) => setTimeout(r, 0));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('starts reporting when identify() runs before initialize()', async () => {
    const fetchMock = routedFetch();
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const client = FeatureflipClient.get({ clientKey: uniqueKey(), baseUrl: 'http://x', streaming: false });
    await client.identify({ user_id: 'u2' });
    client.boolVariation('bool-flag', false);
    client.close();

    await vi.waitFor(() => expect(callsTo(fetchMock, '/v1/client/events')).toHaveLength(1));
    expect(sentEvents(fetchMock)).toEqual([
      expect.objectContaining({ type: 'Evaluation', flagKey: 'bool-flag', userId: 'u2' }),
    ]);
  });

  it('attributes reads to a camelCase userId', async () => {
    const fetchMock = routedFetch();
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const client = FeatureflipClient.get({ clientKey: uniqueKey(), baseUrl: 'http://x', streaming: false, context: { userId: 'camel' } });
    await client.initialize();
    client.boolVariation('bool-flag', false);
    client.close();

    await vi.waitFor(() => expect(callsTo(fetchMock, '/v1/client/events')).toHaveLength(1));
    expect(sentEvents(fetchMock)[0]).toMatchObject({ flagKey: 'bool-flag', userId: 'camel' });
  });

  it('forTesting clients do not send the reports-evaluations header on identify', async () => {
    const fetchMock = routedFetch();
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    // identify() opens a stream (streaming defaults on); jsdom has no EventSource.
    vi.stubGlobal('EventSource', class { addEventListener() {} close() {} onerror = null; });
    const client = FeatureflipClient.forTesting({ 'bool-flag': true });
    await client.identify({ user_id: 'u1' });
    vi.unstubAllGlobals();
    const [[, init]] = callsTo(fetchMock, '/v1/client/identify');
    expect((init as RequestInit).headers).not.toHaveProperty('X-Featureflip-Reports-Evaluations');
    client.close();
  });
});
