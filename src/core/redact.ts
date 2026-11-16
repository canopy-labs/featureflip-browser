/**
 * Strips the SDK key out of anything the SDK logs or surfaces as an error.
 *
 * Client SDKs send the key as the `Authorization` header and, for the stream,
 * in the URL query string, so a fetch/EventSource error that quotes the request
 * hands the credential to whatever the host logs to. The SDK does not choose
 * the transport (polyfills, proxies, test doubles), so the key is stripped at
 * the logging boundary rather than at each call site (#5167).
 *
 * @internal Not part of the public API.
 */

const REPLACEMENT = '[redacted]';

/**
 * Below this, the value is not treated as a credential. A real key is
 * `sdk_client_`/`sdk_server_` plus 43 base64url characters (54 total); redacting
 * a short value corrupts every line it appears inside ("k" turns "skipped"
 * into "s[redacted]ipped"). A key too short to be a Featureflip key cannot
 * authenticate, so there is nothing to protect.
 */
export const MIN_REDACTABLE_LENGTH = 20;

export function redactText(text: string, secret: string): string {
  if (secret.length < MIN_REDACTABLE_LENGTH || !text.includes(secret)) return text;
  return text.split(secret).join(REPLACEMENT);
}

/**
 * True when `value` holds the key anywhere we can see: strings, URL, entries of
 * Map/Set/Headers/arrays, own enumerable values, then a JSON fallback. A value
 * we cannot inspect counts as flagged, since it cannot be vouched for.
 */
function containsSecret(value: unknown, secret: string, depth = 0, seen = new Set<unknown>()): boolean {
  if (typeof value === 'string') return value.includes(secret);
  if (value === null || typeof value !== 'object') return false;
  if (seen.has(value)) return false;
  if (depth > 6) return true;
  seen.add(value);
  try {
    if (typeof URL !== 'undefined' && value instanceof URL && String(value).includes(secret)) return true;
    if (value instanceof Error && (value.message.includes(secret) || (value.stack ?? '').includes(secret))) return true;
    const entries = (value as { entries?: unknown }).entries;
    if (typeof entries === 'function' && !Array.isArray(value)) {
      for (const entry of (entries as () => Iterable<unknown>).call(value)) {
        if (containsSecret(entry, secret, depth + 1, seen)) return true;
      }
    } else if (value instanceof Set) {
      for (const v of value) if (containsSecret(v, secret, depth + 1, seen)) return true;
    }
    for (const k of Object.keys(value)) {
      if (containsSecret((value as Record<string, unknown>)[k], secret, depth + 1, seen)) return true;
    }
    const json = JSON.stringify(value);
    return json !== undefined && json.includes(secret);
  } catch {
    return true;
  }
}

function hasSecret(err: Error, secret: string): boolean {
  return err.message.includes(secret) || (err.stack ?? '').includes(secret);
}

/**
 * Redacts an error and returns the value to use from here on. Normally the
 * same error, mutated in place (keeping its class, so `instanceof` checks are
 * unchanged); if it is frozen/sealed, a redacted copy. Non-Error values are
 * returned as a redacted string. Covers `message`, `stack`, `cause` and
 * `AggregateError.errors`. Callers must use the RETURNED value.
 */
export function redactError<E>(err: E, secret: string, depth = 0): E {
  if (secret.length < MIN_REDACTABLE_LENGTH || depth > 5) return err;
  if (typeof err === 'string') return redactText(err, secret) as E;
  if (!(err instanceof Error)) return err;

  const cause = (err as { cause?: unknown }).cause;
  const members = err instanceof AggregateError ? err.errors : undefined;
  let frozen = false;
  for (const field of ['message', 'stack'] as const) {
    const value = err[field];
    if (typeof value === 'string' && value.includes(secret)) {
      try {
        Object.defineProperty(err, field, {
          value: redactText(value, secret),
          writable: true,
          configurable: true,
          enumerable: false,
        });
      } catch {
        frozen = true;
      }
    }
  }
  for (const key of Object.keys(err)) {
    const v = (err as unknown as Record<string, unknown>)[key];
    if (key === 'cause' || !containsSecret(v, secret)) continue;
    try {
      (err as unknown as Record<string, unknown>)[key] = typeof v === 'string' ? redactText(v, secret) : '[redacted object]';
    } catch {
      frozen = true;
    }
  }
  if (frozen || hasSecret(err, secret)) {
    const copy = new Error(redactText(err.message, secret), {
      cause: redactError(cause, secret, depth + 1),
    });
    copy.name = err.name;
    copy.stack = redactText(err.stack ?? '', secret);
    return copy as E;
  }
  try {
    if (cause !== undefined) {
      const redacted = redactError(cause, secret, depth + 1);
      if (redacted !== cause) {
        Object.defineProperty(err, 'cause', { value: redacted, writable: true, configurable: true, enumerable: false });
      }
    }
    if (members) {
      for (let i = 0; i < members.length; i++) members[i] = redactError(members[i], secret, depth + 1);
    }
  } catch {
    // sealed: nested text stays; the log path re-renders through redactArg.
  }
  return err;
}

/** An Error whose text is redacted, whatever was thrown. */
export function toRedactedError(value: unknown, secret: string): Error {
  const out = redactError(value instanceof Error ? value : new Error(String(value)), secret);
  return out instanceof Error ? out : new Error(String(out));
}

function redactArg(arg: unknown, secret: string): unknown {
  if (typeof arg === 'string') return redactText(arg, secret);
  if (arg instanceof Error) return redactError(arg, secret);
  if (arg !== null && typeof arg === 'object') {
    if (!containsSecret(arg, secret)) return arg;
    if (secret.length < MIN_REDACTABLE_LENGTH) return arg;
    try {
      const json = JSON.stringify(arg);
      if (json !== undefined && json.includes(secret)) return redactText(json, secret);
    } catch {
      // fall through
    }
    return '[redacted object]';
  }
  return arg;
}

/** The SDK's only log sink: every SDK-originated line goes through this. */
export function createLogger(secret: string): { warn: (...args: unknown[]) => void } {
  return {
    warn: (...args: unknown[]) => console.warn(...args.map((a) => redactArg(a, secret))),
  };
}
