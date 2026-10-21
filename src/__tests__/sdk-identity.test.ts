import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { FeatureflipClient } from '../client';

/**
 * Every request names the SDK and its version so the Evaluation API can count
 * usage (#4146, contract in #4138). A script cannot set User-Agent in a browser
 * (the Fetch spec forbids it), so it travels as X-Featureflip-SDK. Asserted on
 * the headers handed to fetch for evaluate, identify and the event post,
 * including the keepalive flush a closing page sends.
 *
 * The native EventSource cannot send custom headers, so the stream connect is
 * deliberately not covered: every session's evaluate carries the header.
 */

// vite.config.ts defines __SDK_VERSION__ from package.json; the test below guards
// that the define is present at all, since without it the module throws at load.
const SDK_TOKEN = `featureflip-browser/${__SDK_VERSION__}`;

const FLAGS = { 'bool-flag': { value: true, variation: 'on', reason: 'fallthrough' } };

function routedFetch() {
  return vi.fn(async (url: string, _init?: RequestInit) => {
    if (url.endsWith('/v1/client/events')) return { ok: true, status: 202, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => ({ flags: FLAGS }) };
  });
}

type FetchMock = ReturnType<typeof routedFetch>;

const headersFor = (m: FetchMock, path: string) =>
  m.mock.calls
    .filter(([url]) => String(url).endsWith(path))
    .map(([, init]) => (init as RequestInit).headers as Record<string, string>);

let n = 0;
const uniqueKey = () => `sdk-identity-${++n}`;

/** Drives evaluate, identify and an event flush, returning each one's headers. */
async function capture(wrappers?: string[]) {
  const fetchMock = routedFetch();
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  const client = FeatureflipClient.get({
    clientKey: uniqueKey(),
    baseUrl: 'http://x',
    streaming: false,
    context: { user_id: 'u1' },
    wrappers,
  });
  await client.initialize();
  await client.identify({ user_id: 'u2' });
  client.boolVariation('bool-flag', false);
  client.close(); // final flush, sent with keepalive

  await vi.waitFor(() => expect(headersFor(fetchMock, '/v1/client/events')).toHaveLength(1));
  return {
    evaluate: headersFor(fetchMock, '/v1/client/evaluate')[0]!,
    identify: headersFor(fetchMock, '/v1/client/identify')[0]!,
    events: headersFor(fetchMock, '/v1/client/events')[0]!,
  };
}

describe('SDK identity', () => {
  let originalFetch: typeof globalThis.fetch;
  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
    FeatureflipClient.resetForTesting();
  });

  it('has a real version, not a placeholder', () => {
    expect(__SDK_VERSION__).toMatch(/^\d+\.\d+\.\d+/);
  });

  it('sends featureflip-browser/<version> as X-Featureflip-SDK on evaluate, identify and events', async () => {
    const headers = await capture();

    expect(headers.evaluate['X-Featureflip-SDK']).toBe(SDK_TOKEN);
    expect(headers.identify['X-Featureflip-SDK']).toBe(SDK_TOKEN);
    expect(headers.events['X-Featureflip-SDK']).toBe(SDK_TOKEN);
  });

  it('appends wrapper tokens in order after the SDK token', async () => {
    const headers = await capture(['featureflip-react/1.4.0', 'my-app-shell']);

    const expected = `${SDK_TOKEN} featureflip-react/1.4.0 my-app-shell`;
    expect(headers.evaluate['X-Featureflip-SDK']).toBe(expected);
    expect(headers.identify['X-Featureflip-SDK']).toBe(expected);
    expect(headers.events['X-Featureflip-SDK']).toBe(expected);
  });

  it('drops an invalid wrapper token with a warning and keeps the valid ones', async () => {
    // A space is not a legal product-token character. Identity metadata must
    // never stop the client starting, so the bad token is dropped and said so.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const headers = await capture(['bad token/1', 'ok-wrapper/2']);

    expect(headers.evaluate['X-Featureflip-SDK']).toBe(`${SDK_TOKEN} ok-wrapper/2`);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('bad token/1'));
  });

  it('does not warn about different options when only the wrappers differ', () => {
    // Wrappers identify the caller, not behavior: react-sdk sharing a client key
    // with a direct browser-sdk caller must not trip the config-equality warning.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    globalThis.fetch = routedFetch() as unknown as typeof fetch;
    const key = uniqueKey();

    const a = FeatureflipClient.get({ clientKey: key, baseUrl: 'http://x', streaming: false });
    const b = FeatureflipClient.get({ clientKey: key, baseUrl: 'http://x', streaming: false, wrappers: ['w/1'] });

    expect(warn).not.toHaveBeenCalled();
    a.close();
    b.close();
  });
});
