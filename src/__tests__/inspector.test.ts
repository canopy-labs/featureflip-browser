import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { FeatureflipClient } from '../client';
import type { EvaluationEvent } from '../types';

function mockFetch(flags: Record<string, unknown>) {
  return vi.fn().mockResolvedValue({
    ok: true,
    json: () => Promise.resolve({ flags }),
  });
}

const SNAPSHOT = {
  'bool-flag': { value: true, variation: 'on', reason: 'fallthrough' },
  'string-flag': { value: 'hello', variation: 'v1', reason: 'rule-match:rule-abc-123' },
  'gated-flag': {
    value: false,
    variation: 'off',
    reason: 'prerequisite-failed',
    prerequisiteKey: 'billing-enabled',
  },
};

async function clientWith(inspectors: Array<(e: EvaluationEvent) => void>) {
  globalThis.fetch = mockFetch(SNAPSHOT) as unknown as typeof fetch;
  const client = FeatureflipClient.get({
    clientKey: 'test-key',
    streaming: false,
    context: { user_id: 'alice' },
    inspectors,
  });
  await client.initialize();
  return client;
}

describe('browser inspectors', () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    FeatureflipClient.resetForTesting();
    vi.restoreAllMocks();
  });

  it('fires once per accessor call with the served value and verbatim reason', async () => {
    const events: EvaluationEvent[] = [];
    const client = await clientWith([(e) => events.push(e)]);

    expect(client.boolVariation('bool-flag', false)).toBe(true);

    expect(events).toHaveLength(1);
    expect(events[0].flagKey).toBe('bool-flag');
    expect(events[0].value).toBe(true);
    expect(events[0].variationKey).toBe('on');
    expect(events[0].reason).toBe('fallthrough');
    expect(events[0].ruleId).toBeUndefined();
    expect(events[0].prerequisiteKey).toBeUndefined();
    expect(events[0].context).toEqual({ user_id: 'alice' });
    expect(new Date(events[0].timestamp).toISOString()).toBe(events[0].timestamp);
  });

  it('parses ruleId out of a rule-match reason, leaving reason verbatim', async () => {
    const events: EvaluationEvent[] = [];
    const client = await clientWith([(e) => events.push(e)]);

    client.stringVariation('string-flag', 'fallback');

    expect(events[0].reason).toBe('rule-match:rule-abc-123');
    expect(events[0].ruleId).toBe('rule-abc-123');
  });

  it('forwards prerequisiteKey and leaves ruleId unset', async () => {
    const events: EvaluationEvent[] = [];
    const client = await clientWith([(e) => events.push(e)]);

    client.boolVariation('gated-flag', true);

    expect(events[0].reason).toBe('prerequisite-failed');
    expect(events[0].prerequisiteKey).toBe('billing-enabled');
    expect(events[0].ruleId).toBeUndefined();
  });

  it('reports flag-not-found for an absent flag', async () => {
    const events: EvaluationEvent[] = [];
    const client = await clientWith([(e) => events.push(e)]);

    expect(client.boolVariation('nope', true)).toBe(true);

    expect(events[0].reason).toBe('flag-not-found');
    expect(events[0].value).toBe(true);
    expect(events[0].variationKey).toBeUndefined();
  });

  it('on type mismatch reports the default value but keeps the server reason', async () => {
    const events: EvaluationEvent[] = [];
    const client = await clientWith([(e) => events.push(e)]);

    expect(client.boolVariation('string-flag', false)).toBe(false);

    expect(events[0].value).toBe(false);
    expect(events[0].reason).toBe('rule-match:rule-abc-123');
    expect(events[0].variationKey).toBe('v1');
  });

  it('fires exactly once per accessor across all four accessors', async () => {
    const events: EvaluationEvent[] = [];
    const client = await clientWith([(e) => events.push(e)]);

    client.boolVariation('bool-flag', false);
    expect(events).toHaveLength(1);
    client.stringVariation('string-flag', '');
    expect(events).toHaveLength(2);
    client.numberVariation('bool-flag', 0);
    expect(events).toHaveLength(3);
    client.jsonVariation('bool-flag', null);
    expect(events).toHaveLength(4);
  });

  it('does not fire for flagDetail', async () => {
    const events: EvaluationEvent[] = [];
    const client = await clientWith([(e) => events.push(e)]);

    client.flagDetail('bool-flag');

    expect(events).toHaveLength(0);
  });

  it('isolates a throwing inspector from the value and from siblings', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const seen: string[] = [];
    const client = await clientWith([
      () => {
        throw new Error('boom');
      },
      (e) => seen.push(e.flagKey),
    ]);

    expect(client.boolVariation('bool-flag', false)).toBe(true);
    expect(seen).toEqual(['bool-flag']);
    expect(warn).toHaveBeenCalled();
  });

  it('drops non-function entries instead of throwing', async () => {
    const events: EvaluationEvent[] = [];
    const client = await clientWith([
      null as unknown as (e: EvaluationEvent) => void,
      (e) => events.push(e),
    ]);

    expect(() => client.boolVariation('bool-flag', false)).not.toThrow();
    expect(events).toHaveLength(1);
  });

  it('hands over a context copy that cannot mutate core state', async () => {
    const events: EvaluationEvent[] = [];
    const client = await clientWith([(e) => events.push(e)]);

    client.boolVariation('bool-flag', false);
    (events[0].context as Record<string, unknown>).user_id = 'mallory';
    client.boolVariation('bool-flag', false);

    expect(events[1].context).toEqual({ user_id: 'alice' });
  });

  it('stops firing after close', async () => {
    const events: EvaluationEvent[] = [];
    const client = await clientWith([(e) => events.push(e)]);

    client.boolVariation('bool-flag', false);
    client.close();
    client.boolVariation('bool-flag', false);

    expect(events).toHaveLength(1);
  });

  it('honors inspectors on the forTesting stub path', () => {
    const events: EvaluationEvent[] = [];
    const client = FeatureflipClient.forTesting({ 'stub-flag': true }, [(e) => events.push(e)]);

    expect(client.boolVariation('stub-flag', false)).toBe(true);
    expect(events).toHaveLength(1);
    expect(events[0].flagKey).toBe('stub-flag');
  });

  it('is a no-op with no inspectors configured', async () => {
    globalThis.fetch = mockFetch(SNAPSHOT) as unknown as typeof fetch;
    const client = FeatureflipClient.get({ clientKey: 'test-key', streaming: false });
    await client.initialize();

    expect(() => client.boolVariation('bool-flag', false)).not.toThrow();
  });
});
