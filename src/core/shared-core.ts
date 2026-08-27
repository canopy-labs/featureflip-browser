import type {
  FeatureflipClientConfig,
  EventType,
  EventHandler,
  EvaluationEvent,
  EvaluationInspector,
  FlagChanges,
  FlagValue,
} from '../types';
import { EventEmitter } from '../events';
import { evaluate, identify as httpIdentify } from '../http';
import { StreamingConnection } from '../streaming';
import { createLocalStorageStore, withAnonymousUserId, type AnonymousKeyStore } from './anonymous-key';

/** The engine embeds the matched rule id in the reason as `rule-match:{id}`. */
const RULE_MATCH_PREFIX = 'rule-match:';

/**
 * The fully-defaulted config. `inspectors` is deliberately omitted: functions
 * are not structurally comparable, so including it would make a differing
 * callback trip the "different options" warning on repeat `get()`.
 */
export type ResolvedConfig = Required<Omit<FeatureflipClientConfig, 'inspectors'>>;

/**
 * Resolve a user-supplied config to the fully-defaulted shape. Exported so
 * the factory can compare candidate configs against the cached instance's
 * config without allocating a full core.
 */
export function resolveConfig(config: FeatureflipClientConfig): ResolvedConfig {
  return {
    clientKey: config.clientKey,
    baseUrl: config.baseUrl ?? 'https://eval.featureflip.io',
    context: config.context ?? {},
    streaming: config.streaming ?? true,
    initTimeout: config.initTimeout ?? 10_000,
  };
}

/**
 * Internal shared core owning all expensive resources of a FeatureflipClient:
 * HTTP evaluation, SSE streaming connection, flag store, and event emitter.
 *
 * Refcounted: multiple FeatureflipClient handles can share one core. The real
 * shutdown runs only when the last handle is closed. JS is single-threaded, so
 * the refcount is a plain number — no atomic primitives are required.
 *
 * @internal
 */
export class SharedFeatureflipCore {
  readonly config: ResolvedConfig;
  private flags = new Map<string, FlagValue>();
  private readonly emitter = new EventEmitter();
  private stream: StreamingConnection | null = null;
  private initialized = false;
  private initPromise: Promise<void> | null = null;
  private closed = false;

  private refCount = 1;
  private owningMap: Map<string, SharedFeatureflipCore> | null = null;
  private owningKey: string | null = null;

  private readonly anonymousKeyStore: AnonymousKeyStore;
  private readonly inspectors: EvaluationInspector[];

  constructor(config: FeatureflipClientConfig, store: AnonymousKeyStore = createLocalStorageStore()) {
    if (!config.clientKey) {
      throw new Error('clientKey is required');
    }
    this.config = resolveConfig(config);
    this.anonymousKeyStore = store;
    // Read from the RAW config — inspectors are deliberately not part of the
    // resolved config. Non-function entries are dropped rather than throwing
    // when called, since JS callers bypass the type system.
    this.inspectors = (config.inspectors ?? []).filter(
      (i): i is EvaluationInspector => typeof i === 'function',
    );
  }

  /**
   * Context to send on the wire. Injects a persisted anonymous `user_id` when
   * the caller supplied none, so anonymous users get sticky rollout bucketing.
   * The stored `config.context` is deliberately left raw: the factory compares
   * caller contexts via {@link contextsEqual}, so injecting into the stored
   * context would make every repeat `get()` from an anonymous caller look like
   * a context change and trigger a spurious re-identify.
   */
  private contextForRequests(context: Record<string, unknown>): Record<string, unknown> {
    return withAnonymousUserId(context, this.anonymousKeyStore);
  }

  /**
   * Test-only factory. Bypasses HTTP and SSE; pre-populates the flag store
   * with hardcoded values. Not registered in the factory cache.
   */
  static createForTesting(
    flags: Record<string, unknown>,
    inspectors: EvaluationInspector[] = [],
  ): SharedFeatureflipCore {
    const core = new SharedFeatureflipCore({ clientKey: 'test-key', inspectors });
    for (const [key, value] of Object.entries(flags)) {
      core.flags.set(key, { value, variation: 'test', reason: 'test' });
    }
    core.initialized = true;
    return core;
  }

  get debugRefCount(): number {
    return this.refCount;
  }

  get isShutDown(): boolean {
    return this.closed;
  }

  get isInitialized(): boolean {
    return this.initialized;
  }

  /** Atomically increments the refcount if the core is still alive. */
  tryAcquire(): boolean {
    if (this.closed || this.refCount <= 0) {
      return false;
    }
    this.refCount++;
    return true;
  }

  /**
   * Decrements the refcount. When it reaches zero, runs the real shutdown
   * exactly once. Over-release is a no-op.
   */
  release(): void {
    if (this.refCount <= 0) return;
    this.refCount--;
    if (this.refCount === 0) {
      this.shutdown();
    }
  }

  /** Called by the factory after successfully inserting this core into the owning map. */
  setOwningMap(map: Map<string, SharedFeatureflipCore>, key: string): void {
    this.owningMap = map;
    this.owningKey = key;
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

    try {
      const result = await evaluate(
        this.config.baseUrl,
        this.config.clientKey,
        this.contextForRequests(this.config.context),
        controller.signal,
      );
      // If close() was called mid-flight, bail out before creating an SSE
      // connection on a discarded client.
      if (this.closed) return;
      this.setFlags(result.flags);
    } catch (err) {
      // Non-terminal: the initial evaluate failed (eval-api unreachable at cold
      // start). Fall through to start the stream, which reconnects forever and
      // re-snapshots on connect; serve caller defaults meanwhile. Never reject.
      //
      // But never silently, either: a revoked client key, a 4xx/5xx, a timeout and
      // an unreachable host otherwise all present exactly like a healthy start, and
      // the caller cannot tell a working client from a completely misconfigured one
      // (#2322).
      // Intentionally before the log: if close() ran mid-flight the caller tore this
      // client down on purpose, and a diagnostic about a client that no longer exists
      // is noise, not signal.
      if (this.closed) return;
      console.warn(
        '[featureflip] initial flag fetch failed, serving defaults until the stream recovers:',
        err,
      );
    } finally {
      clearTimeout(timeout);
    }

    if (this.closed) return;
    this.initialized = true;

    if (this.config.streaming) {
      this.stream = this.createStream();
    }
    // With `{ streaming: false }` the browser core is a one-shot evaluator by
    // design: it applies the initial snapshot (or, if that evaluate() failed
    // above, serves caller defaults) and starts NO background data source — there
    // is no polling fallback in the browser SDK. So a cold-start failure in this
    // mode does not self-heal on its own; the caller must re-`initialize()` (or
    // reload) to retry. The default (`streaming` unset -> true) self-heals via the
    // reconnecting stream above. Keep `streaming: false` for one-shot use only.

    this.emitter.emit('ready');
  }

  boolVariation(key: string, defaultValue: boolean): boolean {
    const flag = this.flags.get(key);
    const value =
      flag !== undefined && typeof flag.value === 'boolean' ? flag.value : defaultValue;
    this.notifyInspectors(key, flag, value);
    return value;
  }

  stringVariation(key: string, defaultValue: string): string {
    const flag = this.flags.get(key);
    const value =
      flag !== undefined && typeof flag.value === 'string' ? flag.value : defaultValue;
    this.notifyInspectors(key, flag, value);
    return value;
  }

  numberVariation(key: string, defaultValue: number): number {
    const flag = this.flags.get(key);
    const value =
      flag !== undefined && typeof flag.value === 'number' ? flag.value : defaultValue;
    this.notifyInspectors(key, flag, value);
    return value;
  }

  jsonVariation<T>(key: string, defaultValue: T): T {
    const flag = this.flags.get(key);
    const value = flag === undefined ? defaultValue : (flag.value as T);
    this.notifyInspectors(key, flag, value);
    return value;
  }

  /**
   * Fire the registered inspectors. Called once per variation call, after type
   * coercion, so the event's `value` is exactly what the accessor returns. A
   * throwing inspector is isolated: it neither breaks the returned value nor
   * stops the remaining inspectors.
   */
  private notifyInspectors(
    flagKey: string,
    flag: FlagValue | undefined,
    value: unknown,
  ): void {
    if (this.inspectors.length === 0 || this.closed) return;

    // The flag is absent from the snapshot (unknown key, not yet initialized,
    // or not clientSideVisible). The server never sent a reason for it, so
    // synthesize one in the same kebab-case the rest of the reasons use.
    const reason = flag?.reason ?? 'flag-not-found';
    const ruleId = reason.startsWith(RULE_MATCH_PREFIX)
      ? reason.slice(RULE_MATCH_PREFIX.length) || undefined
      : undefined;

    const event: EvaluationEvent = {
      flagKey,
      // Copy, so a buggy inspector cannot mutate core state. Uses the same
      // anon-id-resolved context the flags were actually evaluated against.
      context: { ...this.contextForRequests(this.config.context) },
      value,
      variationKey: flag?.variation,
      reason,
      ruleId,
      prerequisiteKey: flag?.prerequisiteKey,
      timestamp: new Date().toISOString(),
    };

    for (const inspector of this.inspectors) {
      try {
        inspector(event);
      } catch (err) {
        console.warn('[featureflip] evaluation inspector threw:', err);
      }
    }
  }

  flagDetail(key: string): FlagValue | undefined {
    return this.flags.get(key);
  }

  async identify(context: Record<string, unknown>): Promise<void> {
    const previousContext = this.config.context;
    this.config.context = context;

    // Close the old stream before the HTTP call so stale SSE updates for the
    // previous context don't mutate flags while in-flight.
    if (this.stream) {
      this.stream.close();
      this.stream = null;
    }

    let result: Awaited<ReturnType<typeof httpIdentify>>;
    try {
      result = await httpIdentify(
        this.config.baseUrl,
        this.config.clientKey,
        this.contextForRequests(context),
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

  /**
   * Real shutdown — runs exactly once when the refcount hits zero. Closes
   * the SSE stream and removes the entry from the owning map. Safe to call
   * from release() only.
   */
  private shutdown(): void {
    if (this.closed) return;
    this.closed = true;

    if (this.owningMap && this.owningKey) {
      // Only remove if we're still the mapped instance — defensive against a
      // racing factory call that already replaced us with a new core.
      if (this.owningMap.get(this.owningKey) === this) {
        this.owningMap.delete(this.owningKey);
      }
    }

    this.stream?.close();
    this.stream = null;
  }

  private createStream(): StreamingConnection {
    return new StreamingConnection({
      baseUrl: this.config.baseUrl,
      clientKey: this.config.clientKey,
      context: this.contextForRequests(this.config.context),
      onChange: (flags, isSnapshot) => this.handleFlagUpdate(flags, isSnapshot),
      onError: (error) => this.emitter.emit('error', error),
    });
  }

  private setFlags(
    flags: Record<string, FlagValue>,
  ): void {
    this.flags.clear();
    for (const [key, flag] of Object.entries(flags)) {
      this.flags.set(key, flag);
    }
  }

  private computeChanges(
    newFlags: Record<string, FlagValue>,
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
    flags: Record<string, FlagValue>,
    isSnapshot: boolean,
  ): void {
    // Connect-time snapshot: REPLACE the store (same as identify) so a flag
    // deleted while we were disconnected — absent from the snapshot — is dropped
    // instead of lingering and serving its stale value (#1873). Deltas fall
    // through to the merge below.
    if (isSnapshot) {
      const changes = this.computeChanges(flags);
      this.setFlags(flags);
      if (Object.keys(changes).length > 0) {
        this.emitter.emit('change', changes);
      }
      return;
    }

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

/**
 * Structural comparison of resolved configs for the "options differ on repeat
 * `get()`" warning. The `clientKey` is excluded (it's the cache key itself),
 * as is `context` — contexts often differ between callers and the factory
 * re-identifies the cached core via {@link contextsEqual} instead of flagging.
 */
export function resolvedConfigsEqual(a: ResolvedConfig, b: ResolvedConfig): boolean {
  return (
    a.baseUrl === b.baseUrl &&
    a.streaming === b.streaming &&
    a.initTimeout === b.initTimeout
  );
}

/**
 * Structural equality for evaluation context objects. Used by the factory to
 * decide whether to re-identify a cached core when a new caller passes a
 * different user context. JSON serialization matches the comparison the React
 * provider uses, so the two layers agree on what counts as "same context".
 */
export function contextsEqual(
  a: Record<string, unknown> | undefined,
  b: Record<string, unknown> | undefined,
): boolean {
  return JSON.stringify(a ?? {}) === JSON.stringify(b ?? {});
}
