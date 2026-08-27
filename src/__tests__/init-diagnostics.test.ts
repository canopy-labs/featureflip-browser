import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { FeatureflipClient } from '../client';

/**
 * The initial evaluate is wrapped in a catch that documents its intent well but
 * emits nothing, so a revoked client key, a 4xx/5xx, a timeout and an unreachable
 * host all present identically to a healthy start: initialized, empty store, every
 * flag serving the caller's default (#2322).
 *
 * Serving defaults is CORRECT and stays — the stream started right after reconnects
 * forever and re-snapshots on connect, and rejecting here would break app startup on
 * a transient blip. What was wrong is that the failure left no trace, which is the
 * same defect fixed in flutter (#2290) and android (#2294).
 */
describe('initialization failure diagnostics', () => {
  let originalFetch: typeof globalThis.fetch;
  let originalEventSource: typeof globalThis.EventSource;
  let warn: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    originalEventSource = globalThis.EventSource;
    globalThis.localStorage.clear();
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    globalThis.EventSource = originalEventSource;
    warn.mockRestore();
    FeatureflipClient.resetForTesting();
    globalThis.localStorage.clear();
  });

  const buildClient = () =>
    FeatureflipClient.get({
      clientKey: 'k',
      baseUrl: 'http://x',
      context: {},
      streaming: false,
    });

  function warnings(): string {
    return (warn.mock.calls as unknown[][])
      .map((call) => call.map((arg) => String(arg)).join(' '))
      .join('\n');
  }

  it('logs a diagnostic when the initial evaluate rejects', async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error('network down'));

    const client = buildClient();
    await client.initialize();

    expect(warnings()).toContain('[featureflip]');
    expect(warnings()).toContain('initial flag fetch failed');

    client.close();
  });

  it('logs a diagnostic when the initial evaluate returns a non-ok response', async () => {
    // A 401 from a revoked key is the case most worth telling apart from a
    // healthy start, and it does not reject — it resolves with ok: false.
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      json: () => Promise.resolve({ error: 'invalid client key' }),
    });

    const client = buildClient();
    await client.initialize();

    expect(warnings()).toContain('initial flag fetch failed');

    client.close();
  });

  it('carries the underlying error, not just a label', async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error('a-distinctive-cause'));

    const client = buildClient();
    await client.initialize();

    expect(warnings()).toContain('a-distinctive-cause');

    client.close();
  });

  it('stays quiet on a healthy start', async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue({ ok: true, json: () => Promise.resolve({ flags: {} }) });

    const client = buildClient();
    await client.initialize();

    expect(warnings()).not.toContain('initial flag fetch failed');

    client.close();
  });

  it('still serves defaults and reports initialized (contract unchanged)', async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error('network down'));

    const client = buildClient();
    await client.initialize();

    // Deliberate, and matching flutter + android. A failed initial fetch is
    // non-terminal: the stream reconnects forever and re-snapshots on connect.
    // Rejecting here, or leaving initialized false, would diverge from every other
    // client SDK and can break app startup on a transient blip.
    expect(client.isInitialized).toBe(true);
    expect(client.boolVariation('anything', false)).toBe(false);
    expect(client.stringVariation('anything', 'fallback')).toBe('fallback');

    client.close();
  });
});
