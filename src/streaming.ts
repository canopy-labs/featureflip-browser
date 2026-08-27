import type { FlagValue } from './types';

export interface StreamingOptions {
  baseUrl: string;
  clientKey: string;
  context: Record<string, unknown>;
  /**
   * @param isSnapshot true when this payload is the connect-time full snapshot
   *   (the server marks it `full: true`), false for a subsequent delta. The core
   *   REPLACES its store on a snapshot and MERGES a delta.
   */
  onChange: (flags: Record<string, FlagValue>, isSnapshot: boolean) => void;
  onError?: (error: Error) => void;
}

const MAX_BACKOFF_MS = 30_000;
const INITIAL_BACKOFF_MS = 1_000;

/**
 * Returns a value in [d/2, d] to de-correlate reconnects across many SDK
 * instances (thundering-herd avoidance after a shared outage).
 *
 * Applied to EVERY reconnect, including the first. The drops this absorbs are
 * fleet-wide — one edge event severs every stream at once (#2457) — so every
 * client re-enters the backoff together. Scheduling the raw `backoffMs` there
 * republished the drop's own synchronisation as a reconnect spike one backoff
 * later (#2508). The band stays strictly positive, so a stream that fails
 * immediately still cannot busy-loop.
 */
export function withJitter(delayMs: number): number {
  if (delayMs <= 0) return delayMs;
  const half = delayMs / 2;
  return half + Math.random() * half;
}

export class StreamingConnection {
  private eventSource: EventSource | null = null;
  private options: StreamingOptions;
  private backoffMs = INITIAL_BACKOFF_MS;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private closed = false;
  private _connectionId: string | null = null;

  get connectionId(): string | null {
    return this._connectionId;
  }

  constructor(options: StreamingOptions) {
    this.options = options;
    this.connect();
  }

  private connect(): void {
    if (this.closed) return;

    // Clear stale connectionId from previous connection
    this._connectionId = null;

    const { baseUrl, clientKey, context } = this.options;
    const contextBytes = new TextEncoder().encode(JSON.stringify(context));
    let binary = '';
    for (let i = 0; i < contextBytes.length; i++) {
      binary += String.fromCharCode(contextBytes[i]);
    }
    const encodedContext = btoa(binary);
    const url = `${baseUrl}/v1/client/stream?authorization=${encodeURIComponent(clientKey)}&context=${encodeURIComponent(encodedContext)}`;

    this.eventSource = new EventSource(url);

    this.eventSource.addEventListener('flags-updated', (event: MessageEvent) => {
      try {
        const data = JSON.parse(event.data);
        this.backoffMs = INITIAL_BACKOFF_MS;
        // The connect-time snapshot carries `full: true` so the core can tell it
        // from a delta and REPLACE its store (dropping flags deleted while the
        // stream was down). Keyed off the explicit marker — NOT "first event" —
        // which would collide with a FLAG_REMOVED-first delta.
        const isSnapshot = data.full === true;
        this.options.onChange(data.flags ?? data, isSnapshot);
      } catch {
        // Ignore parse errors
      }
    });

    this.eventSource.addEventListener('connection-ready', (event: MessageEvent) => {
      try {
        const data = JSON.parse(event.data);
        if (data.connectionId) {
          this._connectionId = data.connectionId;
        }
      } catch {
        // Ignore parse errors
      }
    });

    this.eventSource.onerror = () => {
      this.eventSource?.close();
      this.eventSource = null;

      if (!this.closed) {
        this.options.onError?.(new Error('SSE connection error'));
        this.scheduleReconnect();
      }
    };
  }

  private scheduleReconnect(): void {
    if (this.closed || this.reconnectTimer !== null) return;

    // The ladder state stays un-jittered so the doubling is exact; only the
    // scheduled wait is scattered.
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, withJitter(this.backoffMs));

    this.backoffMs = Math.min(this.backoffMs * 2, MAX_BACKOFF_MS);
  }

  close(): void {
    this.closed = true;
    this.eventSource?.close();
    this.eventSource = null;
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }
}
