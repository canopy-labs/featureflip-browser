const STORAGE_KEY = 'featureflip.anonymous_id';
const USER_ID_FIELD = 'user_id';

export interface AnonymousKeyStore {
  read(): string | null;
  write(value: string): void;
}

/**
 * localStorage-backed store. Degrades to a no-op read/write when storage is
 * unavailable (server-side rendering, private-mode quota errors) so the SDK
 * never throws — the worst case is a key that is sticky within the session but
 * not persisted across reloads.
 */
export function createLocalStorageStore(): AnonymousKeyStore {
  // In-memory fallback so the key stays sticky within the session even when
  // localStorage is unavailable (SSR, partitioned/third-party iframes, some
  // private-mode configs). Without it a blocked store reads `null` every call,
  // regenerating a fresh id for each request and defeating sticky bucketing.
  let cached: string | null = null;
  return {
    read() {
      try {
        const stored = globalThis.localStorage?.getItem(STORAGE_KEY) ?? null;
        if (stored !== null) cached = stored;
      } catch {
        // storage unavailable — fall back to the in-memory value
      }
      return cached;
    },
    write(value: string) {
      cached = value;
      try {
        globalThis.localStorage?.setItem(STORAGE_KEY, value);
      } catch {
        // storage unavailable — the in-memory cache keeps it sticky this session
      }
    },
  };
}

function generateKey(): string {
  try {
    if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  } catch {
    // fall through to manual v4
  }
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

function isNonBlank(value: unknown): boolean {
  return typeof value === 'string' && value.trim().length > 0;
}

/**
 * A caller has supplied a real user identifier if either the canonical
 * `user_id` or its accepted camelCase alias `userId` is non-blank — mirroring
 * the engine's ClientContextMapper, which resolves `user_id` first and falls
 * back to `userId`. Either form must suppress anon-key injection so a real user
 * is never double-identified.
 */
function hasRealUserId(context: Record<string, unknown>): boolean {
  return isNonBlank(context[USER_ID_FIELD]) || isNonBlank(context['userId']);
}

/**
 * Returns a context guaranteed to carry a non-blank `user_id`. If the caller
 * already supplied a non-blank `user_id`, the context is returned unchanged so a
 * real user always wins. Otherwise a persisted anonymous id is read (or
 * generated and persisted once) and injected — giving anonymous users sticky
 * percentage-rollout bucketing instead of a fresh random bucket each request.
 */
export function withAnonymousUserId(
  context: Record<string, unknown>,
  store: AnonymousKeyStore,
): Record<string, unknown> {
  if (hasRealUserId(context)) return context;
  let key = store.read();
  if (!isNonBlank(key)) {
    key = generateKey();
    store.write(key);
  }
  return { ...context, [USER_ID_FIELD]: key };
}
