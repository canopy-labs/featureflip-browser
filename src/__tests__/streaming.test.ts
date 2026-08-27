import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { StreamingConnection, withJitter } from '../streaming';

describe('StreamingConnection', () => {
  let originalEventSource: typeof globalThis.EventSource;

  beforeEach(() => {
    originalEventSource = globalThis.EventSource;
  });

  afterEach(() => {
    globalThis.EventSource = originalEventSource;
  });

  it('handles large context objects without crashing', () => {
    // Create a context large enough to exceed the JS argument limit (~100K bytes)
    const largeContext: Record<string, unknown> = {};
    for (let i = 0; i < 5000; i++) {
      largeContext[`attribute_${i}`] = `value_${'x'.repeat(20)}_${i}`;
    }

    let constructedUrl = '';
    const MockES = vi.fn().mockImplementation(function (url: string) {
      constructedUrl = url;
      return {
        addEventListener: vi.fn(),
        close: vi.fn(),
        onerror: null as (() => void) | null,
      };
    });
    globalThis.EventSource = MockES as unknown as typeof EventSource;

    const connection = new StreamingConnection({
      baseUrl: 'https://example.com',
      clientKey: 'test-key',
      context: largeContext,
      onChange: vi.fn(),
    });

    expect(constructedUrl).toContain('/v1/client/stream');
    expect(constructedUrl).toContain('authorization=');
    expect(constructedUrl).toContain('context=');

    connection.close();
  });

  it('marks a full:true payload as a snapshot and a bare payload as a delta', () => {
    // Pins the isSnapshot derivation at the layer that owns it: the connect
    // snapshot carries `full: true`; deltas omit it. Keyed off the explicit
    // marker, not "first flags-updated".
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
    globalThis.EventSource = MockES as unknown as typeof EventSource;

    const onChange = vi.fn();
    const connection = new StreamingConnection({
      baseUrl: 'https://example.com',
      clientKey: 'test-key',
      context: {},
      onChange,
    });

    const snapshotFlags = { a: { value: true, variation: 'on', reason: 'match' } };
    listeners['flags-updated']?.(
      new MessageEvent('flags-updated', {
        data: JSON.stringify({ full: true, flags: snapshotFlags }),
      }),
    );
    expect(onChange).toHaveBeenNthCalledWith(1, snapshotFlags, true);

    const deltaFlags = { a: { value: false, variation: 'off', reason: 'default' } };
    listeners['flags-updated']?.(
      new MessageEvent('flags-updated', {
        data: JSON.stringify({ flags: deltaFlags }),
      }),
    );
    expect(onChange).toHaveBeenNthCalledWith(2, deltaFlags, false);

    connection.close();
  });

  describe('reconnect jitter (#2508)', () => {
    // The drops this backoff absorbs are fleet-wide: one edge event severs every
    // stream at once (#2457 — measured at a 2.5-3.0ms spread across both eval-api
    // pods), so every browser re-enters the backoff together. A constant delay
    // there republishes the drop's own synchronisation as a reconnect spike one
    // backoff later.

    it('scatters a delay instead of returning it unchanged', () => {
      const samples = new Set<number>();
      for (let i = 0; i < 200; i++) samples.add(withJitter(1_000));

      expect(
        samples.size,
        'reconnect delay is deterministic — a fleet-wide drop reconnects in lockstep',
      ).toBeGreaterThan(1);
      for (const d of samples) {
        expect(d).toBeGreaterThanOrEqual(500);
        expect(d).toBeLessThanOrEqual(1_000);
        expect(d).toBeGreaterThan(0); // anti-busy-loop
      }
    });

    it('schedules the real reconnect with a jittered delay, not the raw backoff', () => {
      // Guards the WIRING, not just the helper: an exported-but-unused withJitter
      // would pass the test above and still ship the lockstep. Modelled on the real
      // failure — many independent clients severed at once, each scheduling its
      // first reconnect — so the assertion is that their delays differ.
      const handlers: Array<() => void> = [];
      const MockES = vi.fn().mockImplementation(function () {
        return {
          addEventListener: vi.fn(),
          close: vi.fn(),
          set onerror(handler: (() => void) | null) {
            if (handler) handlers.push(handler);
          },
          get onerror(): (() => void) | null {
            return null;
          },
        };
      });
      globalThis.EventSource = MockES as unknown as typeof EventSource;

      const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');
      const connections = Array.from({ length: 40 }, () =>
        new StreamingConnection({
          baseUrl: 'https://example.com',
          clientKey: 'test-key',
          context: {},
          onChange: vi.fn(),
        }),
      );

      for (const fire of handlers) fire();

      const delays = setTimeoutSpy.mock.calls.map((call) => call[1] as number);
      expect(delays).toHaveLength(connections.length);
      expect(
        new Set(delays).size,
        'every client scheduled the same first-reconnect delay — a fleet-wide drop reconnects in lockstep',
      ).toBeGreaterThan(1);
      for (const d of delays) {
        expect(d).toBeGreaterThanOrEqual(500);
        expect(d).toBeLessThanOrEqual(1_000);
      }

      setTimeoutSpy.mockRestore();
      for (const c of connections) c.close();
    });
  });
});
