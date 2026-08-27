import type {
  FeatureflipClientConfig,
  EventType,
  EventHandler,
  EvaluationInspector,
  FlagValue,
} from './types';
import { SharedFeatureflipCore, contextsEqual, resolveConfig, resolvedConfigsEqual } from './core/shared-core';

/**
 * Process-wide cache of shared cores keyed by client key. JS is single-threaded
 * so a plain Map is sufficient — no locking needed for get-or-create.
 */
const liveCores = new Map<string, SharedFeatureflipCore>();

/**
 * The browser SDK's public client. Obtain instances via the static factory
 * {@link FeatureflipClient.get}; direct instantiation is not supported.
 * Multiple `get` calls with the same client key return handles sharing one
 * underlying shared core (refcounted); the shared core shuts down when the
 * last handle is closed.
 */
export class FeatureflipClient {
  private readonly core: SharedFeatureflipCore;
  private disposed = false;

  /** Private — construction goes through the static factory or test helpers. */
  private constructor(core: SharedFeatureflipCore) {
    this.core = core;
  }

  /**
   * Returns a client for the given client key. The first call with a given
   * key constructs and registers a shared core; subsequent calls with the
   * same key return a new handle pointing at the cached core. When the last
   * handle for a key is closed, the core shuts down and is removed from the
   * cache.
   *
   * This design makes it safe to call `get()` repeatedly from framework
   * bindings, React effect hooks, or anywhere else — StrictMode double-mounts
   * and per-render construction are all harmless because they all resolve to
   * one underlying SSE connection and flag store per key.
   *
   * The `config` argument is honored only on the first call for a given
   * client key. Subsequent callers that pass meaningfully different baseUrl /
   * streaming / initTimeout will log a warning; the cached instance's config
   * is preserved.
   */
  static get(config: FeatureflipClientConfig): FeatureflipClient {
    if (!config.clientKey) {
      throw new Error('clientKey is required');
    }
    const clientKey = config.clientKey;

    // Retry loop handles the race where a cached core is found but has
    // already begun shutting down (refcount hit 0 between lookup and
    // tryAcquire). In single-threaded JS this rarely iterates more than
    // once, but the pattern keeps semantics aligned with the multi-threaded
    // reference implementations (C#, Java).
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const existing = liveCores.get(clientKey);
      if (existing) {
        if (existing.tryAcquire()) {
          const candidateConfig = resolveConfig(config);
          if (!resolvedConfigsEqual(existing.config, candidateConfig)) {
            console.warn(
              '[featureflip] FeatureflipClient.get called with different options ' +
                'for a client key already in use. The cached instance\'s options are ' +
                'preserved; the passed options are ignored.',
            );
          }
          // Context is intentionally NOT part of resolvedConfigsEqual (each
          // caller has its own user). When the new caller's context differs
          // from the cached core's current context, re-identify so the core
          // evaluates flags for the *new* caller's user instead of silently
          // serving the previous caller's. Fire-and-forget — errors surface
          // via the 'error' event the caller will subscribe to.
          if (!contextsEqual(existing.config.context, candidateConfig.context)) {
            existing.identify(candidateConfig.context).catch(() => {
              // swallowed; emitted on 'error'
            });
          }
          return new FeatureflipClient(existing);
        }
        // Stale entry — core shut down between lookup and acquire. Drop it.
        if (liveCores.get(clientKey) === existing) {
          liveCores.delete(clientKey);
        }
        continue;
      }

      const newCore = new SharedFeatureflipCore(config);
      liveCores.set(clientKey, newCore);
      newCore.setOwningMap(liveCores, clientKey);
      return new FeatureflipClient(newCore);
    }
  }

  /** Initialize the client — loads flags and (if streaming) opens the SSE connection. */
  initialize(): Promise<void> {
    return this.core.initialize();
  }

  /**
   * Whether the client has completed initialization. `initialize()` never
   * rejects — even when the initial evaluate fails, initialization still
   * completes (serving caller defaults while the SSE stream self-heals), so
   * this becomes `true` once `initialize()` resolves — and `false` again once this
   * handle is closed, since a closed handle can no longer evaluate anything.
   */
  get isInitialized(): boolean {
    return !this.disposed && this.core.isInitialized;
  }

  // A closed handle serves the caller's default (#2327, contract from #2313).
  // close() releases the core — closing the SSE connection and dropping the cache
  // entry — but the in-memory snapshot stays readable, so without these guards the
  // handle would keep serving a frozen snapshot that can never update again.

  boolVariation(key: string, defaultValue: boolean): boolean {
    if (this.disposed) return defaultValue;
    return this.core.boolVariation(key, defaultValue);
  }

  stringVariation(key: string, defaultValue: string): string {
    if (this.disposed) return defaultValue;
    return this.core.stringVariation(key, defaultValue);
  }

  numberVariation(key: string, defaultValue: number): number {
    if (this.disposed) return defaultValue;
    return this.core.numberVariation(key, defaultValue);
  }

  jsonVariation<T>(key: string, defaultValue: T): T {
    if (this.disposed) return defaultValue;
    return this.core.jsonVariation(key, defaultValue);
  }

  /**
   * Returns the full evaluation detail for a flag, including `value`,
   * `variation`, `reason`, and (when the server set it) `prerequisiteKey`.
   * Useful when callers need to know *why* a flag served a particular
   * variation — for example, distinguishing a `prerequisite-failed` off
   * variation from a normal `fallthrough` off variation. Returns `undefined`
   * if the flag is unknown, the client has not yet initialized, or the handle
   * has been closed.
   */
  flagDetail(key: string): FlagValue | undefined {
    if (this.disposed) return undefined;
    return this.core.flagDetail(key);
  }

  async identify(context: Record<string, unknown>): Promise<void> {
    return this.core.identify(context);
  }

  on(event: EventType, handler: EventHandler): void {
    this.core.on(event, handler);
  }

  off(event: EventType, handler: EventHandler): void {
    this.core.off(event, handler);
  }

  /**
   * Close this handle. If this is the last handle for the shared core, the
   * core is shut down (SSE connection closed, entry removed from cache).
   * Double-close on the same handle is idempotent and does not
   * double-decrement the refcount.
   */
  close(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.core.release();
  }

  /**
   * Create a test client with hardcoded flag values. No network calls are
   * made and no background processes are started. The test client is NOT
   * registered in the factory cache — each call returns an independent
   * instance.
   */
  static forTesting(
    flags: Record<string, unknown>,
    inspectors: EvaluationInspector[] = [],
  ): FeatureflipClient {
    const core = SharedFeatureflipCore.createForTesting(flags, inspectors);
    return new FeatureflipClient(core);
  }

  /**
   * Current number of live shared cores in the factory cache. Diagnostic only.
   * @internal
   */
  static get debugLiveCoreCount(): number {
    return liveCores.size;
  }

  /**
   * Returns the shared core's current refcount for the given client key, or 0
   * if no core is cached for that key. Diagnostic only.
   * @internal
   */
  static debugRefCount(clientKey: string): number {
    return liveCores.get(clientKey)?.debugRefCount ?? 0;
  }

  /**
   * Reset the factory cache. For test isolation only — forces shutdown of
   * each currently-cached core.
   * @internal
   */
  static resetForTesting(): void {
    const cores = [...liveCores.values()];
    liveCores.clear();
    for (const core of cores) {
      while (core.debugRefCount > 0 && !core.isShutDown) {
        core.release();
      }
    }
  }
}
