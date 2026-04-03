import type { FeatureflipClientConfig, EventType, EventHandler, FlagChanges } from './types';
import { EventEmitter } from './events';
import { evaluate, identify } from './http';
import { StreamingConnection } from './streaming';

interface StoredFlag {
  value: unknown;
  variation: string;
  reason: string;
}

export class FeatureflipClient {
  private config: Required<FeatureflipClientConfig>;
  private flags = new Map<string, StoredFlag>();
  private emitter = new EventEmitter();
  private stream: StreamingConnection | null = null;
  private initialized = false;
  private initPromise: Promise<void> | null = null;
  private closed = false;

  constructor(config: FeatureflipClientConfig) {
    if (!config.clientKey) {
      throw new Error('clientKey is required');
    }

    this.config = {
      clientKey: config.clientKey,
      baseUrl: config.baseUrl ?? 'https://eval.featureflip.io',
      context: config.context ?? {},
      streaming: config.streaming ?? true,
      initTimeout: config.initTimeout ?? 10_000,
    };
  }

  initialize(): Promise<void> {
    if (this.initialized) return Promise.resolve();
    if (!this.initPromise) {
      this.initPromise = this.doInitialize();
    }
    return this.initPromise;
  }

  private async doInitialize(): Promise<void> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.config.initTimeout);

    let result: Awaited<ReturnType<typeof evaluate>>;
    try {
      result = await evaluate(
        this.config.baseUrl,
        this.config.clientKey,
        this.config.context,
        controller.signal,
      );
    } finally {
      clearTimeout(timeout);
    }

    // If close() was called while the fetch was in-flight, bail out
    // to avoid creating an SSE connection on a discarded client.
    if (this.closed) return;

    this.setFlags(result.flags);
    this.initialized = true;

    if (this.config.streaming) {
      this.stream = this.createStream();
    }

    this.emitter.emit('ready');
  }

  boolVariation(key: string, defaultValue: boolean): boolean {
    const flag = this.flags.get(key);
    if (flag === undefined) return defaultValue;
    return typeof flag.value === 'boolean' ? flag.value : defaultValue;
  }

  stringVariation(key: string, defaultValue: string): string {
    const flag = this.flags.get(key);
    if (flag === undefined) return defaultValue;
    return typeof flag.value === 'string' ? flag.value : defaultValue;
  }

  numberVariation(key: string, defaultValue: number): number {
    const flag = this.flags.get(key);
    if (flag === undefined) return defaultValue;
    return typeof flag.value === 'number' ? flag.value : defaultValue;
  }

  jsonVariation<T>(key: string, defaultValue: T): T {
    const flag = this.flags.get(key);
    if (flag === undefined) return defaultValue;
    return flag.value as T;
  }

  async identify(context: Record<string, unknown>): Promise<void> {
    const previousContext = this.config.context;
    this.config.context = context;

    // Close the old stream before the HTTP call so stale SSE updates
    // for the previous context don't mutate flags while in-flight
    if (this.stream) {
      this.stream.close();
      this.stream = null;
    }

    let result: Awaited<ReturnType<typeof identify>>;
    try {
      result = await identify(
        this.config.baseUrl,
        this.config.clientKey,
        context,
      );
    } catch (err) {
      // Revert context so it stays consistent with the current flags
      this.config.context = previousContext;
      this.emitter.emit('error', err instanceof Error ? err : new Error(String(err)));

      // Re-establish SSE with the original context
      if (this.config.streaming) {
        this.stream = this.createStream();
      }

      throw err;
    }

    const changes = this.computeChanges(result.flags);
    this.setFlags(result.flags);

    if (Object.keys(changes).length > 0) {
      this.emitter.emit('change', changes);
    }

    if (this.config.streaming) {
      this.stream = this.createStream();
    }
  }

  on(event: EventType, handler: EventHandler): void {
    this.emitter.on(event, handler);
  }

  off(event: EventType, handler: EventHandler): void {
    this.emitter.off(event, handler);
  }

  close(): void {
    this.closed = true;
    this.stream?.close();
    this.stream = null;
  }

  static forTesting(flags: Record<string, unknown>): FeatureflipClient {
    const client = Object.create(FeatureflipClient.prototype) as FeatureflipClient;
    client.config = {
      clientKey: 'test-key',
      baseUrl: 'http://localhost',
      context: {},
      streaming: false,
      initTimeout: 10_000,
    };
    client.flags = new Map();
    client.emitter = new EventEmitter();
    client.stream = null;
    client.initialized = true;
    client.closed = false;

    for (const [key, value] of Object.entries(flags)) {
      client.flags.set(key, { value, variation: 'test', reason: 'test' });
    }

    return client;
  }

  private createStream(): StreamingConnection {
    return new StreamingConnection({
      baseUrl: this.config.baseUrl,
      clientKey: this.config.clientKey,
      context: this.config.context,
      onChange: (flags) => this.handleFlagUpdate(flags),
      onError: (error) => this.emitter.emit('error', error),
    });
  }

  private setFlags(
    flags: Record<string, { value: unknown; variation: string; reason: string }>,
  ): void {
    this.flags.clear();
    for (const [key, flag] of Object.entries(flags)) {
      this.flags.set(key, flag);
    }
  }

  private computeChanges(
    newFlags: Record<string, { value: unknown; variation: string; reason: string }>,
  ): FlagChanges {
    const changes: FlagChanges = {};

    for (const [key, newFlag] of Object.entries(newFlags)) {
      const oldFlag = this.flags.get(key);
      const oldValue = oldFlag?.value;
      if (oldValue !== newFlag.value) {
        changes[key] = { oldValue, newValue: newFlag.value };
      }
    }

    // Check for removed flags
    for (const [key] of this.flags) {
      if (!(key in newFlags)) {
        changes[key] = { oldValue: this.flags.get(key)!.value, newValue: undefined };
      }
    }

    return changes;
  }

  private handleFlagUpdate(
    flags: Record<string, { value: unknown; variation: string; reason: string }>,
  ): void {
    // SSE sends only changed flags, so merge into existing state
    const changes: FlagChanges = {};

    for (const [key, flag] of Object.entries(flags)) {
      if (flag.reason === 'FLAG_REMOVED' && flag.value === null) {
        // Flag was removed server-side
        const oldFlag = this.flags.get(key);
        if (oldFlag !== undefined) {
          changes[key] = { oldValue: oldFlag.value, newValue: undefined };
          this.flags.delete(key);
        }
      } else {
        const oldFlag = this.flags.get(key);
        if (oldFlag === undefined || oldFlag.value !== flag.value) {
          changes[key] = { oldValue: oldFlag?.value, newValue: flag.value };
        }
        this.flags.set(key, flag);
      }
    }

    if (Object.keys(changes).length > 0) {
      this.emitter.emit('change', changes);
    }
  }
}
