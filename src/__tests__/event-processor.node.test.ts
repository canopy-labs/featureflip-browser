// @vitest-environment node
import { describe, it, expect, vi } from 'vitest';
import { EventProcessor } from '../core/event-processor';

describe('EventProcessor without a DOM (SSR / Node import)', () => {
  it('starts and stops without touching window or document', () => {
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: true, status: 202 });
    const p = new EventProcessor({ baseUrl: 'http://eval.test', clientKey: 'ck' });
    expect(() => { p.start(); p.stop(); }).not.toThrow();
  });
});
