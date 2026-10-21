export interface FeatureflipClientConfig {
  clientKey: string;
  baseUrl?: string;
  context?: Record<string, unknown>;
  streaming?: boolean;
  initTimeout?: number;
  /**
   * Report which flags your application reads, so Featureflip can tell a flag
   * your code still uses from one it only sends (default `true`). This is what
   * lets an unused client-side flag be archived; evaluation analytics count
   * reads rather than page loads. Set `false` to send no evaluation events —
   * the server then records every flag it serves to this client, as older SDK
   * versions did.
   */
  sendEvaluationEvents?: boolean;
  /**
   * In-process observers fired on every variation call. Honored on the first
   * `get()` per client key (singleton-by-construction); deliberately excluded
   * from the resolved config and the config-equality check, since functions are
   * not structurally comparable.
   */
  inspectors?: EvaluationInspector[];
  /**
   * Flag values to serve before the first server response, so the first paint
   * doesn't wait on the network. Either:
   *
   * - an object of `{ flagKey: value }`, typically evaluated by a server SDK
   *   while rendering the page and embedded in the HTML; or
   * - `'localStorage'`, to serve the values this browser last received for the
   *   same client key and context, and keep them up to date as new ones arrive.
   *
   * Either way the client is initialized at once and `initialize()` resolves
   * without waiting; the server's values then replace these, emitting `change`
   * for any that differ. Honored on the first `get()` per client key, and
   * excluded from the config-equality check.
   */
  bootstrap?: Record<string, unknown> | 'localStorage';
  /**
   * `name/version` tokens for libraries that wrap this SDK (`@featureflip/react`,
   * a design-system shell), sent in order after `featureflip-browser/<version>`
   * in the `X-Featureflip-SDK` header so usage through each can be counted. An
   * invalid token is ignored with a warning. Honored on the first `get()` per
   * client key, and excluded from the config-equality check: it identifies the
   * caller rather than changing behavior.
   */
  wrappers?: string[];
}

/**
 * Where the flag values currently being served came from: `'bootstrap'` (the
 * object passed as `bootstrap`), `'localStorage'` (values persisted by an
 * earlier page load), `'server'` (an evaluate response or the stream), or
 * `'none'` (nothing yet; every variation call returns its default).
 */
export type FlagSource = 'none' | 'bootstrap' | 'localStorage' | 'server';

/** Passed to `'ready'` handlers. */
export interface ReadyEvent {
  /** What the client had to serve when it became ready. */
  source: FlagSource;
}

export interface InitializeOptions {
  /**
   * Resolve only once the first server response has been applied (or has
   * failed), even when bootstrap values made the client ready earlier.
   * Default `false`.
   */
  waitForServer?: boolean;
}

export interface FlagValue {
  value: unknown;
  /**
   * The served variation's key. Empty for a value from a `bootstrap` object,
   * which carries values only; the server's response fills it in.
   */
  variation: string;
  /**
   * The server's reason, or `'bootstrap'` / `'persisted'` for a value served
   * from the `bootstrap` option before the server has answered.
   */
  reason: string;
  /**
   * Key of the prerequisite flag that caused this flag to serve its off
   * variation. Set only when `reason === 'prerequisite-failed'`; omitted by
   * the server (and therefore `undefined` here) in all other cases.
   */
  prerequisiteKey?: string;
}

export interface FlagChanges {
  [flagKey: string]: { oldValue: unknown; newValue: unknown };
}

export type EventType = 'ready' | 'change' | 'error';
export type EventHandler = (...args: unknown[]) => void;

/**
 * Emitted once per variation call. `reason` is the server's kebab-case string
 * forwarded verbatim — client SDKs do not run a local evaluator, so the engine
 * is their evaluator. The one synthesized value is `flag-not-found`, used when
 * the flag is absent from the snapshot.
 */
export interface EvaluationEvent {
  flagKey: string;
  context: Record<string, unknown>;
  value: unknown;
  /** The served arm. Unset when the flag is absent from the snapshot. */
  variationKey?: string;
  reason: string;
  /** Parsed from a `rule-match:{id}` reason; unset for every other reason. */
  ruleId?: string;
  /** Set by the server only when `reason === 'prerequisite-failed'`. */
  prerequisiteKey?: string;
  /** ISO-8601. */
  timestamp: string;
}

/** An in-process observer invoked on every variation call. Return value ignored. */
export type EvaluationInspector = (event: EvaluationEvent) => void;
