import type { EvaluationReadEvent } from './read-recorder';

export interface EventProcessorOptions {
  baseUrl: string;
  clientKey: string;
  flushIntervalMs?: number;
  batchSize?: number;
  maxQueueSize?: number;
  onVisible?: () => void;
}

/** Statuses worth retrying: the batch is put back and sent on the next tick. */
function isRetryable(status: number): boolean {
  return status >= 500 || status === 429;
}

/**
 * Batches events to POST /v1/client/events. Mirrors the mobile SDKs' processors:
 * a 30 s / 100-event flush, a 1000-event cap that drops the oldest, retry on
 * 5xx/429/network and drop on any other 4xx. A browser tab can close at any
 * moment, so pagehide and visibilitychange→hidden flush with `keepalive`, which
 * lets the request outlive the page (sendBeacon cannot set Authorization).
 *
 * Nothing is sent until start(): the core starts it from initialize(), so a
 * core that is never initialized (createForTesting, a test double) never
 * touches the network.
 *
 * @internal
 */
export class EventProcessor {
  private queue: EvaluationReadEvent[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  private started = false;
  private stopped = false;
  private inFlight = false;

  private readonly url: string;
  private readonly clientKey: string;
  private readonly flushIntervalMs: number;
  private readonly batchSize: number;
  private readonly maxQueueSize: number;
  private readonly onVisible: (() => void) | undefined;

  constructor(options: EventProcessorOptions) {
    this.url = `${options.baseUrl}/v1/client/events`;
    this.clientKey = options.clientKey;
    this.flushIntervalMs = options.flushIntervalMs ?? 30_000;
    this.batchSize = Math.max(1, options.batchSize ?? 100);
    this.maxQueueSize = Math.max(1, options.maxQueueSize ?? 1000);
    this.onVisible = options.onVisible;
  }

  get queueLength(): number {
    return this.queue.length;
  }

  enqueue(event: EvaluationReadEvent): void {
    if (this.stopped) return;
    this.queue.push(event);
    this.trim();
    if (this.started && this.queue.length >= this.batchSize) {
      void this.flush();
    }
  }

  start(): void {
    if (this.started || this.stopped) return;
    this.started = true;
    this.timer = setInterval(() => { void this.flush(); }, this.flushIntervalMs);
    // Don't hold a Node process open (SSR, tests) just to flush analytics.
    (this.timer as { unref?: () => void }).unref?.();
    if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
      window.addEventListener('pagehide', this.onPageHide);
    }
    if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
      document.addEventListener('visibilitychange', this.onVisibilityChange);
    }
  }

  stop(): void {
    if (this.stopped) return;
    const wasStarted = this.started;
    if (wasStarted) {
      void this.flush(true);
    }
    this.stopped = true;
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (typeof window !== 'undefined' && typeof window.removeEventListener === 'function') {
      window.removeEventListener('pagehide', this.onPageHide);
    }
    if (typeof document !== 'undefined' && typeof document.removeEventListener === 'function') {
      document.removeEventListener('visibilitychange', this.onVisibilityChange);
    }
    this.queue = [];
  }

  /** Sends one batch. Never rejects. A keepalive flush is allowed alongside an in-flight one. */
  async flush(keepalive = false): Promise<void> {
    if (this.stopped || this.queue.length === 0) return;
    if (this.inFlight && !keepalive) return;
    const batch = this.queue.splice(0, this.batchSize);
    if (!keepalive) this.inFlight = true;
    try {
      const response = await fetch(this.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: this.clientKey },
        body: JSON.stringify({ events: batch }),
        keepalive,
      });
      if (!response.ok && isRetryable(response.status)) {
        this.requeue(batch);
      }
    } catch {
      this.requeue(batch);
    } finally {
      if (!keepalive) this.inFlight = false;
    }
  }

  private requeue(batch: EvaluationReadEvent[]): void {
    if (this.stopped) return;
    this.queue = batch.concat(this.queue);
    this.trim();
  }

  private trim(): void {
    if (this.queue.length > this.maxQueueSize) {
      this.queue.splice(0, this.queue.length - this.maxQueueSize);
    }
  }

  private readonly onPageHide = (): void => {
    void this.flush(true);
  };

  private readonly onVisibilityChange = (): void => {
    if (document.visibilityState === 'hidden') {
      void this.flush(true);
    } else if (document.visibilityState === 'visible') {
      try {
        this.onVisible?.();
      } catch {
        // never throw into the page's event loop
      }
    }
  };
}
