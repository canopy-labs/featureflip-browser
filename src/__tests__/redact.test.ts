import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { FeatureflipClient } from '../client';
import { createLogger, redactError } from '../core/redact';

const KEY = 'sdk_client_SentinelKeyMustNeverAppearInLogs-0123456789';

describe('redactor (#5167)', () => {
  let warn: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => warn.mockRestore());

  it('redacts the key from an Error whose message quotes the request', () => {
    createLogger(KEY).warn('failed:', new TypeError(`fetch ?authorization=${KEY} failed`));
    const err = warn.mock.calls[0][1] as Error;
    expect(err.message).toBe('fetch ?authorization=[redacted] failed');
    expect(err.stack).not.toContain(KEY);
    expect(err).toBeInstanceOf(TypeError);
  });

  it('redacts the message and structured fields', () => {
    createLogger(KEY).warn(`key ${KEY}`, { url: `http://x/?a=${KEY}` });
    expect(JSON.stringify(warn.mock.calls)).not.toContain(KEY);
    expect(warn.mock.calls[0][0]).toBe('key [redacted]');
  });

  it('leaves a short key alone', () => {
    createLogger('k').warn('skipped a malformed flag', new Error('k'));
    expect(warn.mock.calls[0][0]).toBe('skipped a malformed flag');
    expect((warn.mock.calls[0][1] as Error).message).toBe('k');
    expect(redactError(new Error('abc'), 'abc').message).toBe('abc');
  });
});

describe('sentinel key never reaches output (#5166)', () => {
  let originalFetch: typeof globalThis.fetch;
  let originalEventSource: typeof globalThis.EventSource;
  const sinks: Record<string, ReturnType<typeof vi.spyOn>> = {};

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    originalEventSource = globalThis.EventSource;
    globalThis.localStorage.clear();
    for (const m of ['log', 'info', 'warn', 'error', 'debug'] as const) {
      sinks[m] = vi.spyOn(console, m).mockImplementation(() => {});
    }
    globalThis.EventSource = vi.fn().mockImplementation(function () {
      return { addEventListener: vi.fn(), close: vi.fn(), onerror: null };
    }) as unknown as typeof EventSource;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
    globalThis.EventSource = originalEventSource;
    Object.values(sinks).forEach((s) => s.mockRestore());
    FeatureflipClient.resetForTesting();
  });

  const captured = () => JSON.stringify(Object.values(sinks).map((s) => (s.mock.calls as unknown[][]).map((c) =>
    c.map((a) => (a instanceof Error ? `${a.name}: ${a.message}\n${a.stack}` : a)))));

  const transportError = () => new TypeError(`request to http://x/v1/client/evaluate?authorization=${KEY} failed (Authorization: ${KEY})`);

  for (const [name, fetchImpl] of [
    ['200', () => Promise.resolve({ ok: true, json: () => Promise.resolve({ flags: { f: { value: true, variation: 'on', reason: 'match' } } }) })],
    ['401', () => Promise.resolve({ ok: false, status: 401 })],
    ['500', () => Promise.resolve({ ok: false, status: 500 })],
    ['transport error', () => Promise.reject(transportError())],
  ] as const) {
    it(`init against ${name}, evaluate, mismatch, unknown flag, duplicate get, close`, async () => {
      globalThis.fetch = vi.fn().mockImplementation(fetchImpl) as unknown as typeof fetch;
      const raised: unknown[] = [];
      const client = FeatureflipClient.get({ clientKey: KEY, baseUrl: 'http://x', context: {}, wrappers: ['bad wrapper'] });
      client.on('error', (e) => raised.push(e));
      try { await client.initialize(); } catch (e) { raised.push(e); }
      client.boolVariation('f', false);
      client.stringVariation('f', 'd'); // type mismatch
      client.boolVariation('missing', false); // unknown flag
      FeatureflipClient.get({ clientKey: KEY, baseUrl: 'http://other', context: {} }); // options ignored
      await client.identify({ key: 'u2' }).catch((e) => raised.push(e));
      client.close();
      FeatureflipClient.resetForTesting();

      expect(captured()).not.toContain(KEY);
      for (const e of raised) expect(String((e as Error).message ?? e)).not.toContain(KEY);
    });
  }

  it('an identify() failure raised to the caller and emitted carries no key', async () => {
    let call = 0;
    globalThis.fetch = vi.fn().mockImplementation(() =>
      ++call === 1
        ? Promise.resolve({ ok: true, json: () => Promise.resolve({ flags: {} }) })
        : Promise.reject(transportError()),
    ) as unknown as typeof fetch;
    const client = FeatureflipClient.get({ clientKey: KEY, baseUrl: 'http://x', context: {} });
    const emitted: Error[] = [];
    client.on('error', (e) => emitted.push(e as Error));
    await client.initialize();
    const thrown = await client.identify({ key: 'u2' }).catch((e: Error) => e);
    expect((thrown as Error).message).toContain('[redacted]');
    expect((thrown as Error).message).not.toContain(KEY);
    expect(emitted.length).toBeGreaterThan(0);
    for (const e of emitted) expect(e.message).not.toContain(KEY);
    client.close();
  });

  for (const [label, make] of [
    ['a frozen Error', () => Object.freeze(new TypeError(`bad ?authorization=${KEY}`))],
    ['a string', () => `bad ?authorization=${KEY}`],
  ] as const) {
    it(`identify() failing with ${label} hands out no key`, async () => {
      let call = 0;
      globalThis.fetch = vi.fn().mockImplementation(() =>
        ++call === 1
          ? Promise.resolve({ ok: true, json: () => Promise.resolve({ flags: {} }) })
          : Promise.reject(make()),
      ) as unknown as typeof fetch;
      const client = FeatureflipClient.get({ clientKey: KEY, baseUrl: 'http://x', context: {} });
      const emitted: Error[] = [];
      client.on('error', (e) => emitted.push(e as Error));
      await client.initialize();
      const thrown = (await client.identify({ key: 'u2' }).catch((e: unknown) => e)) as Error;
      expect(thrown).toBeInstanceOf(Error);
      expect(thrown.message).toContain('[redacted]');
      expect(`${thrown.message}${thrown.stack}`).not.toContain(KEY);
      expect(emitted.length).toBeGreaterThan(0);
      for (const e of emitted) expect(`${e.message}${e.stack}`).not.toContain(KEY);
      client.close();
    });
  }

  it('redacts cause, AggregateError members and unserialisable objects', () => {
    const agg = new AggregateError([new Error(`x ${KEY}`)], `agg ${KEY}`, { cause: new Error(`c ${KEY}`) });
    const out = redactError(agg, KEY);
    expect(JSON.stringify([out.message, out.errors.map((e: Error) => e.message), (out.cause as Error).message])).not.toContain(KEY);
    const frozen = Object.freeze(new Error(`f ${KEY}`, { cause: new Error(`c ${KEY}`) }));
    const copy = redactError(frozen, KEY);
    expect(copy).not.toBe(frozen);
    expect(`${copy.message}${copy.stack}${(copy.cause as Error).message}`).not.toContain(KEY);
    const cyc: Record<string, unknown> = { k: KEY };
    cyc.self = cyc;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    createLogger(KEY).warn(cyc);
    expect(warn.mock.calls[0][0]).toBe('[redacted object]');
    warn.mockRestore();
  });

  it('never passes a flagged non-plain object through', () => {
    class Holder { constructor(public h = new Headers({ Authorization: KEY })) {} }
    const err = Object.assign(new Error('clean'), { config: { headers: { Authorization: KEY } } });
    const cases: unknown[] = [
      new Headers({ Authorization: KEY }),
      new Map([['Authorization', KEY]]),
      new Set([KEY]),
      new URL(`http://x/?authorization=${KEY}`),
      new Holder(),
    ];
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    for (const c of cases) createLogger(KEY).warn(c);
    createLogger(KEY).warn(err);
    const clean = new Map([['a', 'b']]);
    createLogger(KEY).warn(clean);
    for (const call of warn.mock.calls.slice(0, cases.length)) {
      expect(String(call[0])).not.toContain(KEY);
      expect(JSON.stringify(call[0])).not.toContain(KEY);
    }
    const logged = warn.mock.calls[cases.length][0] as Error;
    expect(logged.message).toBe('clean');
    expect(JSON.stringify((logged as unknown as { config: unknown }).config)).not.toContain(KEY);
    expect(warn.mock.calls[cases.length + 1][0]).toBe(clean);
    warn.mockRestore();
  });
});
