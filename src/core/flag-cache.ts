import type { FlagValue } from '../types';

export const FLAG_CACHE_STORAGE_KEY = 'featureflip.flags';

/** Contexts kept per browser profile; the least recently saved is evicted first. */
export const MAX_CACHED_CONTEXTS = 5;

/** The reason a value loaded from the cache carries, in place of the one the server sent. */
export const PERSISTED_REASON = 'persisted';

interface CacheEntry {
  savedAt: number;
  flags: Record<string, FlagValue>;
}

interface StoredCache {
  version: 1;
  entries: Record<string, CacheEntry>;
}

/**
 * Last-known flag values per (client key, evaluation context), for the
 * `bootstrap: 'localStorage'` option. An entry is only ever served back to
 * the exact client key and context it was saved for.
 *
 * @internal
 */
export interface FlagCache {
  load(clientKey: string, context: Record<string, unknown>): Record<string, FlagValue> | null;
  save(clientKey: string, context: Record<string, unknown>, flags: Record<string, FlagValue>): void;
}

/**
 * JSON with object keys sorted, so `{a, b}` and `{b, a}` name the same entry.
 * Returns null when the context cannot be serialized (a cycle, a BigInt).
 */
function canonicalJson(value: unknown): string | null {
  try {
    return JSON.stringify(value, (_key, v: unknown) => {
      if (v === null || typeof v !== 'object' || Array.isArray(v)) return v;
      const sorted: Record<string, unknown> = {};
      for (const k of Object.keys(v).sort()) sorted[k] = (v as Record<string, unknown>)[k];
      return sorted;
    });
  } catch {
    return null;
  }
}

/**
 * cyrb53: a fast 53-bit string hash. The entry is named by a hash rather than
 * by the context itself so attributes like an email address never land in
 * localStorage. Not a security boundary; only five entries ever exist, so a
 * collision is not a practical concern.
 */
function hash53(s: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < s.length; i++) {
    const ch = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

function entryKey(clientKey: string, context: Record<string, unknown>): string | null {
  const json = canonicalJson(context);
  return json === null ? null : hash53(`${clientKey}\u0000${json}`);
}

function isObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function readStored(): StoredCache | null {
  try {
    const raw = globalThis.localStorage?.getItem(FLAG_CACHE_STORAGE_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (!isObject(parsed) || parsed.version !== 1 || !isObject(parsed.entries)) return null;
    return parsed as unknown as StoredCache;
  } catch {
    // unavailable storage, or a value some other code (or an older version) wrote
    return null;
  }
}

function writeStored(stored: StoredCache): boolean {
  try {
    globalThis.localStorage?.setItem(FLAG_CACHE_STORAGE_KEY, JSON.stringify(stored));
    return true;
  } catch {
    return false;
  }
}

/**
 * localStorage-backed {@link FlagCache}. Every failure degrades to "nothing
 * cached": private mode, a full quota, a blocked third-party iframe and a
 * corrupt value all behave like a first visit, and none of them throw.
 */
export function createLocalStorageFlagCache(
  maxEntries: number = MAX_CACHED_CONTEXTS,
  now: () => number = Date.now,
): FlagCache {
  const cap = Math.max(1, maxEntries);
  return {
    load(clientKey, context) {
      const key = entryKey(clientKey, context);
      if (key === null) return null;
      const entry = readStored()?.entries[key];
      if (!isObject(entry) || !isObject(entry.flags)) return null;

      const flags: Record<string, FlagValue> = {};
      for (const [flagKey, flag] of Object.entries(entry.flags)) {
        if (!isObject(flag) || !('value' in flag) || typeof flag.variation !== 'string') continue;
        // The stored reason described the evaluation that produced the value, not
        // why it is being served now. prerequisiteKey goes with it: it is only
        // meaningful alongside reason === 'prerequisite-failed'.
        flags[flagKey] = { value: flag.value, variation: flag.variation, reason: PERSISTED_REASON };
      }
      return flags;
    },

    save(clientKey, context, flags) {
      const key = entryKey(clientKey, context);
      if (key === null) return;
      const entry: CacheEntry = { savedAt: now(), flags };

      const stored: StoredCache = { version: 1, entries: {} };
      // Carry over only well-formed entries: anything else in storage came from
      // another writer, and must not be able to make this throw.
      for (const [k, e] of Object.entries(readStored()?.entries ?? {})) {
        if (isObject(e) && typeof e.savedAt === 'number' && isObject(e.flags)) stored.entries[k] = e;
      }
      stored.entries[key] = entry;
      const keys = Object.keys(stored.entries);
      if (keys.length > cap) {
        keys
          .sort((a, b) => stored.entries[a].savedAt - stored.entries[b].savedAt)
          .slice(0, keys.length - cap)
          .forEach((k) => delete stored.entries[k]);
      }
      if (writeStored(stored)) return;
      // Most likely the quota: keep only the current context rather than nothing.
      writeStored({ version: 1, entries: { [key]: entry } });
    },
  };
}
