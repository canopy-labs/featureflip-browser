import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventProcessor } from '../core/event-processor';
import type { EvaluationReadEvent } from '../core/read-recorder';

const ev = (flagKey: string): EvaluationReadEvent => ({
  type: 'Evaluation',
  flagKey,
  variation: 'on',
  userId: 'u',
  timestamp: '2026-10-07T00:00:00.000Z',
});

function okFetch(status = 202) {
  return vi.fn().mockResolvedValue({ ok: status < 400, status });
}

describe('EventProcessor', () => {
  let originalFetch: typeof globalThis.fetch;
  beforeEach(() => {
    originalFetch = globalThis.fetch;
    vi.useFakeTimers();
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.useRealTimers();
  });

  const make = (opts: Partial<ConstructorParameters<typeof EventProcessor>[0]> = {}) =>
    new EventProcessor({ baseUrl: 'http://eval.test', clientKey: 'ck', ...opts });

  it('sends nothing before start(), even past the batch size', async () => {
    const fetchMock = okFetch();
    globalThis.fetch = fetchMock;
    const p = make({ batchSize: 2 });
    p.enqueue(ev('a'));
    p.enqueue(ev('b'));
    p.enqueue(ev('c'));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(p.queueLength).toBe(3);
  });

  it('flushes on the interval with the client key and the events body', async () => {
    const fetchMock = okFetch();
    globalThis.fetch = fetchMock;
    const p = make();
    p.start();
    p.enqueue(ev('a'));
    await vi.advanceTimersByTimeAsync(30_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('http://eval.test/v1/client/events');
    expect(init.method).toBe('POST');
    expect(init.headers).toEqual({ 'Content-Type': 'application/json', Authorization: 'ck' });
    expect(JSON.parse(init.body)).toEqual({ events: [ev('a')] });
    expect(p.queueLength).toBe(0);
    p.stop();
  });

  it('flushes as soon as a started queue reaches the batch size, in batches', async () => {
    const fetchMock = okFetch();
    globalThis.fetch = fetchMock;
    const p = make({ batchSize: 2 });
    p.start();
    p.enqueue(ev('a'));
    expect(fetchMock).not.toHaveBeenCalled();
    p.enqueue(ev('b'));
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).events).toHaveLength(2);
    p.stop();
  });

  it.each([500, 503, 429])('puts the batch back on %i and sends it on the next tick', async (status) => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: false, status })
      .mockResolvedValue({ ok: true, status: 202 });
    globalThis.fetch = fetchMock;
    const p = make();
    p.start();
    p.enqueue(ev('a'));
    await vi.advanceTimersByTimeAsync(30_000);
    expect(p.queueLength).toBe(1);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(JSON.parse(fetchMock.mock.calls[1][1].body).events[0].flagKey).toBe('a');
    expect(p.queueLength).toBe(0);
    p.stop();
  });

  it('puts the batch back when fetch rejects (network error)', async () => {
    globalThis.fetch = vi.fn().mockRejectedValueOnce(new TypeError('offline')).mockResolvedValue({ ok: true, status: 202 });
    const p = make();
    p.start();
    p.enqueue(ev('a'));
    await vi.advanceTimersByTimeAsync(30_000);
    expect(p.queueLength).toBe(1);
    p.stop();
  });

  it.each([400, 401, 413])('drops the batch on non-retryable %i', async (status) => {
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: false, status });
    const p = make();
    p.start();
    p.enqueue(ev('a'));
    await vi.advanceTimersByTimeAsync(30_000);
    expect(p.queueLength).toBe(0);
    p.stop();
  });

  it('caps the queue by dropping the oldest events', () => {
    globalThis.fetch = okFetch();
    const p = make({ maxQueueSize: 3 });
    for (const k of ['a', 'b', 'c', 'd', 'e']) p.enqueue(ev(k));
    expect(p.queueLength).toBe(3);
  });

  it('flushes with keepalive on pagehide and when the page becomes hidden', async () => {
    const fetchMock = okFetch();
    globalThis.fetch = fetchMock;
    const p = make();
    p.start();

    p.enqueue(ev('a'));
    window.dispatchEvent(new Event('pagehide'));
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][1].keepalive).toBe(true);

    p.enqueue(ev('b'));
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1][1].keepalive).toBe(true);
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
    p.stop();
  });

  it('calls onVisible when the page becomes visible again', () => {
    globalThis.fetch = okFetch();
    const onVisible = vi.fn();
    const p = make({ onVisible });
    p.start();
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
    expect(onVisible).toHaveBeenCalledTimes(1);
    p.stop();
    document.dispatchEvent(new Event('visibilitychange'));
    expect(onVisible).toHaveBeenCalledTimes(1); // detached after stop
  });

  it('stop() sends what is queued with keepalive, then detaches timer and listeners', async () => {
    const fetchMock = okFetch();
    globalThis.fetch = fetchMock;
    const p = make();
    p.start();
    p.enqueue(ev('a'));
    p.stop();
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][1].keepalive).toBe(true);

    p.enqueue(ev('b')); // ignored after stop
    window.dispatchEvent(new Event('pagehide'));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('stop() on a never-started processor sends nothing', async () => {
    const fetchMock = okFetch();
    globalThis.fetch = fetchMock;
    const p = make();
    p.enqueue(ev('a'));
    p.stop();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('flush() never rejects, even if fetch throws synchronously', async () => {
    globalThis.fetch = vi.fn(() => { throw new Error('boom'); }) as unknown as typeof fetch;
    const p = make();
    p.start();
    p.enqueue(ev('a'));
    await expect(p.flush()).resolves.toBeUndefined();
    p.stop();
  });
});
