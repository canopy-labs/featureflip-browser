# @featureflip/browser-sdk

Framework-agnostic browser SDK for evaluating Featureflip feature flags.

## Installation

```bash
npm install @featureflip/browser-sdk
```

## Quick Start

```ts
import { FeatureflipClient } from '@featureflip/browser-sdk';

const client = new FeatureflipClient({
  clientKey: 'your-client-sdk-key',
});

await client.initialize();

const showBanner = client.boolVariation('show-banner', false);
```

## API Reference

### Constructor

```ts
new FeatureflipClient(config: FeatureflipClientConfig)
```

### Configuration Options

| Option | Type | Default | Description |
|---|---|---|---|
| `clientKey` | `string` | **(required)** | Client SDK key from your project settings |
| `baseUrl` | `string` | `https://eval.featureflip.io` | Evaluation API base URL |
| `context` | `Record<string, unknown>` | `{}` | Initial evaluation context (user attributes) |
| `streaming` | `boolean` | `true` | Enable SSE streaming for real-time updates |
| `initTimeout` | `number` | `10000` | Timeout in ms for the initial evaluate request |

### Methods

#### `initialize(): Promise<void>`

Fetches all flag values from the server. Must be called before reading variations. Opens an SSE streaming connection if `streaming` is enabled.

#### `boolVariation(key: string, defaultValue: boolean): boolean`

Returns a boolean flag value, or `defaultValue` if the flag is missing or not a boolean.

#### `stringVariation(key: string, defaultValue: string): string`

Returns a string flag value, or `defaultValue` if the flag is missing or not a string.

#### `numberVariation(key: string, defaultValue: number): number`

Returns a number flag value, or `defaultValue` if the flag is missing or not a number.

#### `jsonVariation<T>(key: string, defaultValue: T): T`

Returns a flag value cast to `T`, or `defaultValue` if the flag is missing.

#### `identify(context: Record<string, unknown>): Promise<void>`

Re-evaluates all flags with a new context (e.g., after login). Emits `change` events for any flags whose values changed.

```ts
await client.identify({ user_id: '123', plan: 'pro' });
```

#### `on(event: EventType, handler: EventHandler): void`

Subscribe to events.

- `'ready'` -- fired after `initialize()` completes
- `'change'` -- fired when flag values change (receives a `FlagChanges` object)
- `'error'` -- fired on streaming or network errors

```ts
client.on('change', (changes) => {
  console.log('Flags changed:', changes);
});
```

#### `off(event: EventType, handler: EventHandler): void`

Unsubscribe from events.

#### `close(): void`

Closes the SSE streaming connection and cleans up resources.

### Testing

Use `FeatureflipClient.forTesting()` to create a client with predetermined flag values -- no network calls.

```ts
const client = FeatureflipClient.forTesting({
  'show-banner': true,
  'button-color': 'blue',
});

client.boolVariation('show-banner', false); // true
client.stringVariation('button-color', 'red'); // 'blue'
```
