export interface FeatureflipClientConfig {
  clientKey: string;
  baseUrl?: string;
  context?: Record<string, unknown>;
  streaming?: boolean;
  initTimeout?: number;
  /**
   * In-process observers fired on every variation call. Honored on the first
   * `get()` per client key (singleton-by-construction); deliberately excluded
   * from the resolved config and the config-equality check, since functions are
   * not structurally comparable.
   */
  inspectors?: EvaluationInspector[];
}

export interface FlagValue {
  value: unknown;
  variation: string;
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
