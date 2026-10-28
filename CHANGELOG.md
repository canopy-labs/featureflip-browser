# Changelog

## 2.17.2 — 2026-10-27

### Fixed

- `FeatureflipClient.forTesting()` clients no longer reach the network on `identify()`. The call used to POST to the Evaluation API and open a stream, so a test that switched users got a real request, or a rejected promise where no `EventSource` exists. It now updates the context and keeps the seeded flags, like `forServerRender()`. (#4358)

## 2.17.1 — 2026-10-27

### Changed

- The type declarations now ship as one rolled-up `.d.ts` per entry point instead of a file per source module. The exported types are unchanged. (#4346)

## 2.17.0 — 2026-10-27

### Changed

- Republished in lockstep with `@featureflip/edge` 2.17.0. This package has no source changes of its own. Recorded here because the npm release tag publishes all five JavaScript packages at a single version. (#4210)

## 2.16.0 — 2026-10-26

### Changed

- Republished in lockstep with `@featureflip/js` 2.16.0. This package has no source changes of its own. Recorded here because the npm release tag publishes all five JavaScript packages at a single version. (#1372)

## 2.15.0 — 2026-10-22

### Changed

- Republished in lockstep with `@featureflip/js` 2.15.0. This package has no source changes of its own. Recorded here because the npm release tag publishes all five JavaScript packages at a single version. (#1372)

## 2.14.1 — 2026-10-21

### Changed

- Republished in lockstep with `@featureflip/js` 2.14.1. This package has no source changes of its own. Recorded here because the npm release tag publishes all five JavaScript packages at a single version. (#1372)

## 2.14.0 — 2026-10-20

### Changed

- Republished in lockstep with `@featureflip/react` 2.14.0, which now identifies itself through this package's `wrappers` option. This package has no source changes of its own. Recorded here because the npm release tag publishes all four JavaScript packages at a single version. (#4147)

## 2.13.0 — 2026-10-20

### Added

- Every request to evaluate, identify and the event endpoint now carries `X-Featureflip-SDK: featureflip-browser/<version>`, including the keepalive flush a closing page sends. The SDK previously sent nothing that identified it: its requests carried only the end user's browser `User-Agent`, which a script cannot change. The header adds no CORS preflight, because `Authorization` already makes these requests non-simple. The SSE stream still carries no identity, since the native `EventSource` cannot send custom headers. The version is inlined from `package.json` at build time, so it cannot go stale between releases. (#4146)
- A `wrappers` option for libraries that wrap this SDK, such as `@featureflip/react`. Each `name/version` token is sent, in order, after the SDK's own, so usage through the wrapper can be counted. An invalid token is ignored with a warning, and differing wrappers do not trigger the "different options" warning. (#4146)

## 2.12.0 — 2026-10-20

### Added

- A new `bootstrap` option lets the first paint use real flag values instead of waiting on the network. (#4095)
  - Pass an object of `{ flagKey: value }`, for example the values your server SDK evaluated while rendering the page, and the client is initialized as soon as it is created. It makes no request before your first render, and `initialize()` resolves at once. The client then fetches as before, and the server's values replace the bootstrap ones, firing `change` for any that differ.
  - Pass `'localStorage'` and the client saves the values it receives for each client key and context, then serves them on the next page load until the fresh ones arrive. Values saved for one context are never served to another. Storage holds the five most recently used contexts and names each entry by a hash, so context attributes are not written to storage. A failing or full `localStorage` falls back to the normal start, and a server SDK key is never persisted.
- `initialize({ waitForServer: true })` waits for the first server response even when bootstrap values have already made the client ready.
- `flagSource` reports where the values being served came from (`'bootstrap'`, `'localStorage'`, `'server'` or `'none'`), and the `ready` event now passes `{ source }` with the same values.
- `FeatureflipClient.forServerRender(config)` returns a client for server-side rendering. It serves the `bootstrap` values, makes no requests and is not shared through the client cache, so concurrent requests for different users never see each other's values.
- Reads of bootstrap values are reported like any other read. Evaluation inspectors see reason `'bootstrap'` or `'persisted'` until the server's values arrive, and a value from a bootstrap object has no variation key.

### Fixed

- A context change during the initial fetch no longer serves the previous user's flags. When `identify()` (or a repeat `get()` with a different context) started before the first evaluate response arrived, that response was applied anyway, so the new user was served the old user's values until their own arrived, or, if the old response came last, until the next stream snapshot (never, with `streaming: false`). The same happened when two `identify()` calls overlapped and the earlier one answered last, and a failing earlier call reverted the context over the newer one. Superseded responses are now dropped. (#4095)
- In that same overlap, the initial fetch and `identify()` each opened a stream, and the first one was never closed. Opening a stream now closes the previous one.

## 2.11.1 — 2026-10-09

### Changed

- `package.json` now declares `"sideEffects": false`. Loading the package does nothing on its own: no globals, no timers, no listeners, no patched built-ins. Bundlers (webpack, Rollup, esbuild, Vite) can now drop an unused import of it and tree-shake its unused exports, where before they had to keep the whole module in case loading it mattered. A test now loads both of its builds (ESM and CommonJS) in a clean Node process on every change and fails if that stops being true. No runtime behaviour changes. (#3562)

## 2.11.0 — 2026-10-07

### Added

- The SDK now reports which flags your application reads, deduplicated to at most about one event an hour per flag, variation and user (and again when the page becomes visible after being hidden), sent in small batches (within 30 seconds, or when the page is hidden or closed), and tells Featureflip it does so. A client-side flag that your code no longer reads therefore stops counting as in use, and it can be archived once no client reads it, provided the clients receiving it run a version that reports reads (browser or React 2.11.0 or later). Clients on 2.10.0 or older, and SDKs that don't report reads, still count every flag they are sent. Two effects to expect:
  - Evaluation analytics for client-side flags now count reads rather than page loads.
  - Flags that are sent but never read may newly show as stale.

  The new `sendEvaluationEvents: false` option turns reporting off, and Featureflip then treats every flag it sends to that client as in use, as before. (#3545)

## 2.10.0 — 2026-09-18

### Changed

- Republished in lockstep with `@featureflip/js` 2.10.0. This package had no source changes of its own, and it is **not** affected by that release's SSE fallback fix: this SDK has no polling fallback at all and its stream already reconnected forever with a jittered backoff, which is the behaviour the server-side SDKs were brought into line with. Recorded here because the npm release tag publishes all four JavaScript packages at a single version, so this version exists on npm with no change of its own to describe. (#3071)

## 2.9.0 — 2026-09-01

### Changed

- Republished in lockstep with `@featureflip/js` 2.9.0. This package had no source changes of its own, and unlike the server-side SDKs it is **not** affected by that release's operator-spelling fix: client SDKs do not run a local evaluator, so the evaluation engine resolves the operator and this SDK forwards its answer verbatim. Recorded here because the npm release tag publishes all four JavaScript packages at a single version, so this version exists on npm with no change of its own to describe. (#2374)

## 2.8.0 — 2026-08-26

### Fixed

- The first SSE reconnect after a healthy stream drops is now jittered to `[d/2, d]`, like every other backoff level. The drops this absorbs are fleet-wide — a single edge event severs every stream at once — so every client re-entered the backoff together and waited an identical delay, republishing the drop's own synchronisation as a reconnect spike one backoff later. Measured in production: a drop spread across 2.5–3.0 ms produced a reconnect spread of 26–46 ms. The delay never exceeds the previous one and stays strictly positive, so a stream that fails immediately still cannot busy-loop. (#2508)

## 2.7.1 — 2026-08-24

### Changed

- Republished in lockstep with `@featureflip/js` 2.7.1. This package had no source changes of its own; it receives that release's date-operand fixes through its `@featureflip/js` dependency. Recorded here because the npm release tag publishes all four JavaScript packages at a single version, so this version exists on npm with no entry in this file. (#2468)

## 2.6.1 — 2026-08-23

### Changed

- Version aligned with the npm release line. No functional change in this package.

## 2.6.0 — 2026-08-20

### Fixed

- A closed handle serves the caller's default from every accessor and reports not-initialized. `close()` releases the shared core — stopping streaming and polling, shutting down the event processor — but the in-memory snapshot stayed readable, so a closed client kept evaluating against a frozen snapshot that could never update again while still reporting itself initialized. (#2327)

- A failed initial flag fetch is now diagnosable rather than swallowed by a bare `catch`. (#2322)

## 2.5.4 — 2026-08-18

No functional change. The four JS SDKs share one release line — an `npm-v*` tag publishes all of them at the tag's version — and 2.5.4 is a `@featureflip/js` fix (#2245) to its CommonJS entrypoint, which the browser build does not use.

## 2.5.3 — 2026-08-05

### Fixed

- `LICENSE` is now the verbatim Apache-2.0 text. Three phrases in the operative sections had been reworded and the appendix dropped, which left automated license scanners unable to identify it. The license itself is unchanged; the file now says what it always claimed to.
- The README now states the license. `package.json` declared Apache-2.0 and the `LICENSE` file shipped inside the package, but the README itself said nothing.

### Changed

- The README's opening line links to featureflip.io.

## 2.5.2 — 2026-08-02

No functional change. The four JS SDKs share one release line — an `npm-v*` tag publishes all of them at the tag's version — and 2.5.2 is a `@featureflip/js` fix (#2141) to the Node platform's `User-Agent`, a header browsers forbid setting.

## 2.5.1 — 2026-07-30

No functional change. The four JS SDKs share one release line — an `npm-v*` tag publishes all of them at the tag's version — and 2.5.1 is a `@featureflip/js` fix (#2087) that this package does not consume.

## 2.5.0 — 2026-07-29

### Added

- **`onEvaluation` inspector callback.** `inspectors` config option registering in-process observers fired on every evaluation. Because client SDKs hold a pre-evaluated snapshot rather than running a local evaluator, inspectors are notified from the four variation accessors after type coercion; `flagDetail()` and all-flags accessors stay silent so one decision is never double-counted. `reason` is the engine's kebab-case string forwarded verbatim, and a flag absent from the snapshot synthesizes `flag-not-found` (#1914).

## 2.4.0 — 2026-07-13

### Fixed

- Outage-recovery hardening: initialization is non-terminal, serving defaults and self-healing rather than hanging on a failed initial fetch (#1864, #1896).
- The reconnect snapshot now replaces the store rather than merging, so a flag deleted while the client was disconnected is dropped (#1881).

### Changed

- Enforced `tsc --noEmit` typecheck gate added to CI (#1465).

## 2.3.0 — 2026-06-19

### Added

- A generated anonymous `user_id` is persisted in `localStorage` and injected at every evaluate/identify/SSE call, so anonymous users bucket consistently across sessions (#1467).

## 2.2.0 — 2026-06-16

### Changed

- Version alignment with the JS-family SDKs for the semver targeting operators (#1409).

## 2.1.0 — 2026-05-27

### Added

- `FlagValue.prerequisiteKey?: string` — set by the server when a flag served its off variation because a prerequisite flag failed. Absent in all other cases. Lets callers (and the React SDK) distinguish a `prerequisite-failed` off variation from a normal `fallthrough` off variation (#1126).
- `FeatureflipClient.flagDetail(key)` — returns the full `FlagValue` for a flag (value, variation, reason, optional `prerequisiteKey`) or `undefined` if unknown. Mirrors the equivalent accessor on the Swift, Flutter, and Android client SDKs (#1165).

### Fixed

- Identify is re-sent on context change, and `userId` casing is accepted (#1222).

### Changed

- Monorepo converted to npm workspaces (#1207).

## 2.0.0 — 2026-04-08

### BREAKING

- **Public `FeatureflipClient` constructor removed.** The only way to obtain a client is now the static factory `FeatureflipClient.get(config)`. The factory dedupes by client key: repeated calls with the same key return handles pointing at a single shared underlying client, making framework bindings, React StrictMode double-mounts, and per-component construction all harmless instead of leaking SSE connections.

  **Migration:**

  Before:
  ```ts
  import { FeatureflipClient } from '@featureflip/browser-sdk';

  const client = new FeatureflipClient({ clientKey: 'your-client-sdk-key' });
  ```

  After:
  ```ts
  import { FeatureflipClient } from '@featureflip/browser-sdk';

  const client = FeatureflipClient.get({ clientKey: 'your-client-sdk-key' });
  ```

- **`close()` is now refcounted.** When multiple handles share one cached core, closing one handle does not shut down the core — the SSE connection stays alive until the last handle is closed. Double-closing the same handle is idempotent and does not double-decrement the refcount. `FeatureflipClient.forTesting(...)` clients are not cached by the factory and are always independent.

- **`config` is ignored on repeat calls for the same client key.** The first `get()` for a given key owns the config used by the shared core; subsequent `get()` calls with a meaningfully different `baseUrl` / `streaming` / `initTimeout` will log a warning and reuse the cached core's config. This is intentional — the factory's job is to guarantee one-core-per-key.

### Added

- `FeatureflipClient.get(config)` — static factory, the new primary entry point.
- Internal `SharedFeatureflipCore` class (`src/core/shared-core.ts`) separating expensive resources (HTTP evaluation, SSE connection, flag store, event emitter) from the public handle.
- `FeatureflipClient.debugLiveCoreCount` and `FeatureflipClient.debugRefCount(clientKey)` internal diagnostics for tests and lifetime debugging.
- `FeatureflipClient.resetForTesting()` internal test helper for clean slate between tests.

### Changed

- `FeatureflipClient` is now a thin handle over `SharedFeatureflipCore`. All evaluation, identify, and close operations delegate to the core.

## 1.0.0

Initial release.
