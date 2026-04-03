import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { StreamingConnection } from '../streaming';

describe('StreamingConnection', () => {
  let originalEventSource: typeof globalThis.EventSource;

  beforeEach(() => {
    originalEventSource = globalThis.EventSource;
  });

  afterEach(() => {
    globalThis.EventSource = originalEventSource;
  });

  it('handles large context objects without crashing', () => {
    // Create a context large enough to exceed the JS argument limit (~100K bytes)
    const largeContext: Record<string, unknown> = {};
    for (let i = 0; i < 5000; i++) {
      largeContext[`attribute_${i}`] = `value_${'x'.repeat(20)}_${i}`;
    }

    let constructedUrl = '';
    const MockES = vi.fn().mockImplementation(function (url: string) {
      constructedUrl = url;
      return {
        addEventListener: vi.fn(),
        close: vi.fn(),
        onerror: null as (() => void) | null,
      };
    });
    globalThis.EventSource = MockES as unknown as typeof EventSource;

    const connection = new StreamingConnection({
      baseUrl: 'https://example.com',
      clientKey: 'test-key',
      context: largeContext,
      onChange: vi.fn(),
    });

    expect(constructedUrl).toContain('/v1/client/stream');
    expect(constructedUrl).toContain('authorization=');
    expect(constructedUrl).toContain('context=');

    connection.close();
  });
});
