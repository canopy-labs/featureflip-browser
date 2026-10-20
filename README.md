# @featureflip/browser

Framework-agnostic browser SDK for evaluating [Featureflip](https://featureflip.io) feature flags.

## Installation

```bash
npm install @featureflip/browser
```

## Quick Start

```ts
import { FeatureflipClient } from '@featureflip/browser';

const client = FeatureflipClient.get({
  clientKey: 'your-client-sdk-key',
});

await client.initialize();

const showBanner = client.boolVariation('show-banner', false);
```

> **Singleton by construction.** `FeatureflipClient.get()` is the only way to obtain a client — the public constructor was removed in v2.0. Calling `get()` more than once with the same `clientKey` returns handles pointing at one shared underlying client (refcounted). This makes framework bindings, React StrictMode double-mounts, and per-component construction all harmless — they all resolve to one SSE connection and one flag store per key.

## API Reference

### `FeatureflipClient.get(config)`

```ts
FeatureflipClient.get(config: FeatureflipClientConfig): FeatureflipClient
```

Returns a client for the given client key. The first call constructs and registers a shared core; subsequent calls with the same key return a new handle pointing at the cached core. When the last handle for a key is closed, the core shuts down and is removed from the cache.

### Configuration Options

| Option | Type | Default | Description |
|---|---|---|---|
| `clientKey` | `string` | **(required)** | Client SDK key from your project settings |
| `baseUrl` | `string` | `https://eval.featureflip.io` | Evaluation API base URL |
| `context` | `Record<string, unknown>` | `{}` | Initial evaluation context (user attributes) |
| `streaming` | `boolean` | `true` | Enable SSE streaming for real-time updates |
| `initTimeout` | `number` | `10000` | Timeout in ms for the initial evaluate request |
| `bootstrap` | `Record<string, unknown> \| 'localStorage'` | `undefined` | Values to serve before the first server response. See [Bootstrapping](#bootstrapping). |
| `sendEvaluationEvents` | `boolean` | `true` | Report which flags your app reads. Featureflip uses this to tell a flag your code still reads from one it only sends, which is what lets an unused client-side flag be archived. Only reads through `flagDetail()` or the typed `*Variation` methods count. Set `false` to report nothing — Featureflip then treats every flag it sends to this client as in use. |

### Methods

#### `initialize(options?: { waitForServer?: boolean }): Promise<void>`

Fetches all flag values from the server. Must be called before reading variations (unless the client was bootstrapped). Opens an SSE streaming connection if `streaming` is enabled. With bootstrap values it resolves immediately while the fetch runs in the background; pass `{ waitForServer: true }` to wait for the first server response instead.

#### `flagSource: 'none' | 'bootstrap' | 'localStorage' | 'server'`

Where the values currently being served came from.

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

- `'ready'` -- fired once, when the client first has values to serve (receives `{ source }`, the same values as `flagSource`)
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

Decrements the refcount on the shared core. When the last handle for a given client key is closed, the shared core closes the SSE connection and removes itself from the factory cache. Double-close on the same handle is a no-op.

### Bootstrapping

Pass `bootstrap` so the first paint doesn't wait on the network:

- **An object** of `{ flagKey: value }`, typically evaluated by a server SDK while rendering the page and embedded in the HTML. The client is initialized immediately and makes no request before your first read.
- **`'localStorage'`**: the client saves the values it receives per client key and context (the five most recent contexts, named by a hash so context attributes are not stored) and serves them on the next page load. Values for one context are never served to another. Ignored for a server SDK key.

Either way the client still fetches and streams as usual. The server's values replace the bootstrap ones and emit `change` for any that differ.

```ts
const client = FeatureflipClient.get({
  clientKey: 'your-client-sdk-key',
  context: window.__FLAG_CONTEXT__, // the same context the server evaluated with
  bootstrap: window.__FLAGS__,
});
```

For server-side rendering, `FeatureflipClient.forServerRender(config)` returns a client that serves the `bootstrap` object's values, makes no network requests, and is not cached, so concurrent requests for different users never share one.

Full guide: [Bootstrap client-side flags](https://featureflip.io/docs/guides/bootstrap/).

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

## License

Apache-2.0
