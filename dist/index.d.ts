export declare type EventHandler = (...args: unknown[]) => void;

export declare type EventType = 'ready' | 'change' | 'error';

export declare class FeatureflipClient {
    private config;
    private flags;
    private emitter;
    private stream;
    private initialized;
    private initPromise;
    private closed;
    constructor(config: FeatureflipClientConfig);
    initialize(): Promise<void>;
    private doInitialize;
    boolVariation(key: string, defaultValue: boolean): boolean;
    stringVariation(key: string, defaultValue: string): string;
    numberVariation(key: string, defaultValue: number): number;
    jsonVariation<T>(key: string, defaultValue: T): T;
    identify(context: Record<string, unknown>): Promise<void>;
    on(event: EventType, handler: EventHandler): void;
    off(event: EventType, handler: EventHandler): void;
    close(): void;
    static forTesting(flags: Record<string, unknown>): FeatureflipClient;
    private createStream;
    private setFlags;
    private computeChanges;
    private handleFlagUpdate;
}

export declare interface FeatureflipClientConfig {
    clientKey: string;
    baseUrl?: string;
    context?: Record<string, unknown>;
    streaming?: boolean;
    initTimeout?: number;
}

export declare interface FlagChanges {
    [flagKey: string]: {
        oldValue: unknown;
        newValue: unknown;
    };
}

export declare interface FlagValue {
    value: unknown;
    variation: string;
    reason: string;
}

export { }
