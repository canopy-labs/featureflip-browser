import { afterEach, describe, expect, it, vi } from 'vitest';
import { FeatureflipClient } from '../client';
import type { EvaluationEvent } from '../types';

/**
 * A test double never touches the network (#4358). `forTesting()` set `detached`
 * but not `offline`, so `identify()` still POSTed /v1/client/identify to the
 * default base URL and then opened a stream, which under jsdom throws
 * `EventSource is not defined`. Anything driving a stub through a user switch
 * (an OpenFeature context change, a React provider re-identifying) got a
 * rejected identify or a real request.
 */
describe('forTesting identify', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('resolves without a request and keeps the seeded flags', async () => {
    const fetchSpy = vi.fn(async () => new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchSpy);
    const client = FeatureflipClient.forTesting({ 'bool-flag': true });

    await expect(client.identify({ user_id: 'u2' })).resolves.toBeUndefined();

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(client.boolVariation('bool-flag', false)).toBe(true);
  });

  it('applies the new context, which inspectors then see', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200 })));
    const events: EvaluationEvent[] = [];
    const client = FeatureflipClient.forTesting({ 'bool-flag': true }, [(e) => events.push(e)]);

    await client.identify({ user_id: 'u2' });
    client.boolVariation('bool-flag', false);

    expect(events.at(-1)?.context).toMatchObject({ user_id: 'u2' });
  });
});
