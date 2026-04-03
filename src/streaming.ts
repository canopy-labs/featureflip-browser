export interface StreamingOptions {
  baseUrl: string;
  clientKey: string;
  context: Record<string, unknown>;
  onChange: (flags: Record<string, { value: unknown; variation: string; reason: string }>) => void;
  onError?: (error: Error) => void;
}

const MAX_BACKOFF_MS = 30_000;
const INITIAL_BACKOFF_MS = 1_000;

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
        this.options.onChange(data.flags ?? data);
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

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, this.backoffMs);

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
