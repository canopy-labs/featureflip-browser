export interface FeatureflipClientConfig {
  clientKey: string;
  baseUrl?: string;
  context?: Record<string, unknown>;
  streaming?: boolean;
  initTimeout?: number;
}

export interface FlagValue {
  value: unknown;
  variation: string;
  reason: string;
}

export interface FlagChanges {
  [flagKey: string]: { oldValue: unknown; newValue: unknown };
}

export type EventType = 'ready' | 'change' | 'error';
export type EventHandler = (...args: unknown[]) => void;
