import type {
  FeatureflipClientConfig,
  EventType,
  EventHandler,
  EvaluationEvent,
  EvaluationInspector,
  FlagChanges,
  FlagSource,
  FlagValue,
  InitializeOptions,
} from '../types';
import { EventEmitter } from '../events';
import { evaluate, identify as httpIdentify } from '../http';
import { StreamingConnection } from '../streaming';
import { ReadRecorder } from './read-recorder';
import { EventProcessor } from './event-processor';
import { createLocalStorageStore, withAnonymousUserId, type AnonymousKeyStore } from './anonymous-key';
import { createLocalStorageFlagCache, type FlagCache } from './flag-cache';
import { buildIdentity } from '../identity';

/** The engine embeds the matched rule id in the reason as `rule-match:{id}`. */
const RULE_MATCH_PREFIX = 'rule-match:';

/** The reason a value from a `bootstrap` object carries until the server's replaces it. */
const BOOTSTRAP_REASON = 'bootstrap';

/** Server SDK keys are minted with this prefix (SdkKeyGeneratorService). */
const SERVER_KEY_PREFIX = 'sdk_server';

/**
 * The fully-defaulted config. `inspectors` is deliberately omitted: functions
 * are not structurally comparable, so including it would make a differing
 * callback trip the "different options" warning on repeat `get()`. So is
 * `bootstrap`: it is per page render, so a repeat `get()` passing different
 * values is expected, not a misconfiguration. And so is `wrappers`: it
 * identifies the caller rather than changing behavior.
 */
export type ResolvedConfig = Required<Omit<FeatureflipClientConfig, 'inspectors' | 'bootstrap' | 'wrappers'>>;

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
    sendEvaluationEvents: config.sendEvaluationEvents ?? true,
  };
}

function isNonBlankString(v: unknown): v is string {
  return typeof v === 'string' && v.trim().length > 0;
}

/** Internal: the initial response arrived after identify() moved to another context. */
class SupersededError extends Error {}

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
  private source: FlagSource = 'none';
  /**
   * Set for test doubles and server-render clients: initialize() starts nothing,
   * since there is nothing to fetch for a core that never talks to the network.
   */
  private detached = false;
  /** Set for server-render clients only: identify() records the context and makes no request. */
  private offline = false;

  private refCount = 1;
  private owningMap: Map<string, SharedFeatureflipCore> | null = null;
  private owningKey: string | null = null;

  private readonly anonymousKeyStore: AnonymousKeyStore;
  private readonly inspectors: EvaluationInspector[];
  /** `featureflip-browser/<version>` plus wrapper tokens, built once (#4146). */
  private readonly identity: string;
  /** Non-null only with `bootstrap: 'localStorage'` and a key that may be persisted. */
  private flagCache: FlagCache | null = null;

  /** Null when sendEvaluationEvents is off, and for createForTesting cores. */
  private reads: ReadRecorder | null = null;
  private events: EventProcessor | null = null;
  /** user_id the reads are attributed to; undefined = not yet resolved. Cleared whenever the context changes. */
  private readUserId: { value: string | undefined } | undefined;

  constructor(
    config: FeatureflipClientConfig,
    store: AnonymousKeyStore = createLocalStorageStore(),
    flagCache: () => FlagCache = createLocalStorageFlagCache,
  ) {
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
    // Also from the RAW config, for the same reason (#4146).
    this.identity = buildIdentity(config.wrappers);

    if (this.config.sendEvaluationEvents) {
      const events = new EventProcessor({
        baseUrl: this.config.baseUrl,
        clientKey: this.config.clientKey,
        identity: this.identity,
        // A page coming back into view may have slept through the archive guard's 24 h;
        // start a new read window so its next reads are reported straight away.
        onVisible: () => this.reads?.resetWindow(),
      });
      this.events = events;
      this.reads = new ReadRecorder((e) => events.enqueue(e));
    }

    this.applyBootstrap(config.bootstrap, flagCache);
  }

  /**
   * Seed the store from the `bootstrap` option, before any request. A core
   * with values is initialized from construction, so the very first render
   * (before any effect has called initialize()) already serves them.
   */
  private applyBootstrap(bootstrap: FeatureflipClientConfig['bootstrap'], flagCache: () => FlagCache): void {
    if (bootstrap === 'localStorage') {
      if (this.config.clientKey.startsWith(SERVER_KEY_PREFIX)) {
        // A server key in a browser is already exposed to anyone who opens devtools;
        // don't also leave the flags it unlocks sitting in storage.
        console.warn(
          "[featureflip] bootstrap: 'localStorage' is ignored for a server SDK key. " +
            'Use a client-side SDK key in the browser.',
        );
        return;
      }
      this.flagCache = flagCache();
      const cached = this.flagCache.load(
        this.config.clientKey,
        this.contextForRequests(this.config.context),
      );
      if (cached !== null) {
        this.setFlags(cached);
        this.source = 'localStorage';
        this.initialized = true;
      }
      return;
    }

    if (bootstrap !== null && typeof bootstrap === 'object' && !Array.isArray(bootstrap)) {
      for (const [key, value] of Object.entries(bootstrap)) {
        if (value === undefined) continue;
        this.flags.set(key, { value, variation: '', reason: BOOTSTRAP_REASON });
      }
      this.source = 'bootstrap';
      this.initialized = true;
    }
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
    // A test double reports nothing and never touches the network.
    core.reads = null;
    core.events = null;
    // The header is sent iff reporting is wired, so a stub must not claim it.
    core.config.sendEvaluationEvents = false;
    for (const [key, value] of Object.entries(flags)) {
      core.flags.set(key, { value, variation: 'test', reason: 'test' });
    }
    core.initialized = true;
    core.detached = true;
    // Offline too, or identify() still makes its request and opens a stream
    // (#4358): detached only short-circuits initialize().
    core.offline = true;
    return core;
  }

  /**
   * A core for rendering on the server: serves `config.bootstrap` values (an
   * object; `'localStorage'` means nothing on a server) and never touches the
   * network, storage or the factory cache. Not cached, so one request's user
   * can never be served another's values.
   */
  static createForServerRender(config: FeatureflipClientConfig): SharedFeatureflipCore {
    const bootstrap = typeof config.bootstrap === 'object' ? config.bootstrap : undefined;
    const core = new SharedFeatureflipCore({ ...config, bootstrap }, {
      read: () => null,
      write: () => {},
    });
    core.reads = null;
    core.events = null;
    core.config.sendEvaluationEvents = false;
    core.detached = true;
    core.offline = true;
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

  get flagSource(): FlagSource {
    return this.source;
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

  /**
   * Starts the network side exactly once. A core seeded from `bootstrap` is
   * already initialized, so its callers get an immediate resolve unless they
   * ask to wait for the server; the fetch still starts on that first call.
   */
  initialize(options: InitializeOptions = {}): Promise<void> {
    if (this.detached) return Promise.resolve();
    if (!this.initPromise) {
      // Bootstrapped: ready now, on the values it has; the first response reconciles.
      const readyEarly = this.initialized;
      this.initPromise = this.doInitialize(readyEarly);
      // Emitted only once initPromise is set, so a handler calling initialize() joins it.
      if (readyEarly && !this.closed) this.emitter.emit('ready', { source: this.source });
    }
    if (this.initialized && !options.waitForServer) return Promise.resolve();
    return this.initPromise;
  }

  private async doInitialize(readyEarly: boolean): Promise<void> {
    if (!this.closed) this.events?.start();

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.config.initTimeout);
    // identify() replaces config.context with a new object before its own request,
    // so a reference check tells whether this response still describes the user.
    const requestedFor = this.config.context;

    try {
      const result = await evaluate(
        this.config.baseUrl,
        this.config.clientKey,
        this.contextForRequests(requestedFor),
        controller.signal,
        this.config.sendEvaluationEvents,
        this.identity,
      );
      // If close() was called mid-flight, bail out before creating an SSE
      // connection on a discarded client.
      if (this.closed) return;
      // Superseded by identify(), whose own response will fill the store. Applying
      // this one would serve (and persist) the previous user's values to the new one.
      if (this.config.context !== requestedFor) throw new SupersededError();
      const changes = this.applyServerFlags(result.flags);
      // Without a bootstrap nobody has been served anything yet, so there is
      // nothing to announce a change from; 'ready' below covers it.
      if (readyEarly && Object.keys(changes).length > 0) {
        this.emitter.emit('change', changes);
      }
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
      if (!(err instanceof SupersededError)) console.warn(
        '[featureflip] initial flag fetch failed, serving defaults until the stream recovers:',
        err,
      );
    } finally {
      clearTimeout(timeout);
    }

    if (this.closed) return;
    this.initialized = true;

    if (this.config.streaming) {
      this.openStream();
    }
    // With `{ streaming: false }` the browser core is a one-shot evaluator by
    // design: it applies the initial snapshot (or, if that evaluate() failed
    // above, serves caller defaults) and starts NO background data source — there
    // is no polling fallback in the browser SDK. So a cold-start failure in this
    // mode does not self-heal on its own; the caller must re-`initialize()` (or
    // reload) to retry. The default (`streaming` unset -> true) self-heals via the
    // reconnecting stream above. Keep `streaming: false` for one-shot use only.

    if (!readyEarly) this.emitter.emit('ready', { source: this.source });
  }

  boolVariation(key: string, defaultValue: boolean): boolean {
    const flag = this.flags.get(key);
    const value =
      flag !== undefined && typeof flag.value === 'boolean' ? flag.value : defaultValue;
    this.notifyInspectors(key, flag, value);
    this.recordRead(key, flag);
    return value;
  }

  stringVariation(key: string, defaultValue: string): string {
    const flag = this.flags.get(key);
    const value =
      flag !== undefined && typeof flag.value === 'string' ? flag.value : defaultValue;
    this.notifyInspectors(key, flag, value);
    this.recordRead(key, flag);
    return value;
  }

  numberVariation(key: string, defaultValue: number): number {
    const flag = this.flags.get(key);
    const value =
      flag !== undefined && typeof flag.value === 'number' ? flag.value : defaultValue;
    this.notifyInspectors(key, flag, value);
    this.recordRead(key, flag);
    return value;
  }

  jsonVariation<T>(key: string, defaultValue: T): T {
    const flag = this.flags.get(key);
    const value = flag === undefined ? defaultValue : (flag.value as T);
    this.notifyInspectors(key, flag, value);
    this.recordRead(key, flag);
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
      // A bootstrap value has no variation key; report none rather than ''.
      variationKey: flag?.variation || undefined,
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

  /**
   * Record that application code read `flagKey`. The server credits this
   * client only with the flags it reports here (it sends the
   * X-Featureflip-Reports-Evaluations header), so a flag whose code was
   * removed stops looking evaluated and can be archived.
   */
  private recordRead(flagKey: string, flag: FlagValue | undefined): void {
    if (this.reads === null || this.closed) return;
    this.reads.record(flagKey, flag?.variation || undefined, this.userIdForReads());
  }

  private userIdForReads(): string | undefined {
    if (this.readUserId === undefined) {
      // contextForRequests may hit localStorage; cache it — getSnapshot calls variations on every render.
      // Mirror anonymous-key.ts: a non-blank camelCase `userId` counts when `user_id` is absent.
      const ctx = this.contextForRequests(this.config.context);
      let raw = ctx.user_id;
      if (!isNonBlankString(raw) && isNonBlankString(ctx['userId'])) raw = ctx['userId'];
      this.readUserId = { value: raw === undefined || raw === null ? undefined : String(raw) };
    }
    return this.readUserId.value;
  }

  flagDetail(key: string): FlagValue | undefined {
    const flag = this.flags.get(key);
    this.recordRead(key, flag);
    return flag;
  }

  async identify(context: Record<string, unknown>): Promise<void> {
    const previousContext = this.config.context;
    this.config.context = context;
    this.readUserId = undefined;

    if (this.offline) return;

    // The header below promises this client reports its reads, so the processor
    // must be running even when identify() precedes initialize(). Idempotent.
    if (!this.closed) this.events?.start();

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
        undefined,
        this.config.sendEvaluationEvents,
        this.identity,
      );
    } catch (err) {
      // A later identify() owns the context and the stream now: reverting would undo it.
      if (this.config.context !== context) throw err;
      // Revert context so it stays consistent with the current flags
      this.config.context = previousContext;
      this.readUserId = undefined;
      this.emitter.emit('error', err instanceof Error ? err : new Error(String(err)));

      // Re-establish SSE with the original context
      if (this.config.streaming) {
        this.openStream();
      }

      throw err;
    }

    // Superseded by a later identify(): its response is the one to apply.
    if (this.config.context !== context) return;

    const changes = this.applyServerFlags(result.flags);

    if (Object.keys(changes).length > 0) {
      this.emitter.emit('change', changes);
    }

    if (this.config.streaming) {
      this.openStream();
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
    this.events?.stop();
    this.events = null;
    this.reads = null;
  }

  /**
   * Replace any open stream with one for the current context. The initial fetch
   * and an overlapping identify() both open one when they finish, so assigning
   * without closing would leave the first connected and leaked.
   */
  private openStream(): void {
    this.stream?.close();
    this.stream = this.createStream();
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

  /** Replace the store with a full set of server values; returns what changed. */
  private applyServerFlags(flags: Record<string, FlagValue>): FlagChanges {
    const changes = this.computeChanges(flags);
    this.setFlags(flags);
    this.source = 'server';
    this.persist();
    return changes;
  }

  /**
   * Save the current store as the last-known values for the current context.
   * Called only after server data has been applied, so a bootstrap object is
   * never written. Every caller has checked that the data describes
   * config.context: the initial fetch and identify() drop responses a later
   * identify() superseded, and identify() closes the stream before switching.
   */
  private persist(): void {
    if (this.flagCache === null || this.closed) return;
    this.flagCache.save(
      this.config.clientKey,
      this.contextForRequests(this.config.context),
      Object.fromEntries(this.flags),
    );
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
      const changes = this.applyServerFlags(flags);
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
    this.source = 'server';
    this.persist();

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
    a.initTimeout === b.initTimeout &&
    a.sendEvaluationEvents === b.sendEvaluationEvents
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
