import { describe, it, expect } from 'vitest';
import { ReadRecorder, READ_DEDUPE_WINDOW_MS, type EvaluationReadEvent } from '../core/read-recorder';

function setup(windowMs = READ_DEDUPE_WINDOW_MS) {
  let clock = Date.UTC(2026, 9, 7, 12, 0, 0);
  const events: EvaluationReadEvent[] = [];
  const recorder = new ReadRecorder((e) => events.push(e), windowMs, () => clock);
  return { recorder, events, advance: (ms: number) => { clock += ms; } };
}

describe('ReadRecorder', () => {
  it('uses a one-hour window by default', () => {
    expect(READ_DEDUPE_WINDOW_MS).toBe(3_600_000);
  });

  it('emits one Evaluation event for many reads of the same flag in a window', () => {
    const { recorder, events } = setup();
    for (let i = 0; i < 500; i++) recorder.record('flag-a', 'on', 'user-1');
    expect(events).toEqual([
      {
        type: 'Evaluation',
        flagKey: 'flag-a',
        variation: 'on',
        userId: 'user-1',
        timestamp: new Date(Date.UTC(2026, 9, 7, 12, 0, 0)).toISOString(),
      },
    ]);
  });

  it('treats a different flag, variation or user as a separate read', () => {
    const { recorder, events } = setup();
    recorder.record('flag-a', 'on', 'user-1');
    recorder.record('flag-b', 'on', 'user-1');
    recorder.record('flag-a', 'off', 'user-1');
    recorder.record('flag-a', 'on', 'user-2');
    recorder.record('flag-a', undefined, 'user-1');
    recorder.record('flag-a', 'on', undefined);
    expect(events.map((e) => [e.flagKey, e.variation, e.userId])).toEqual([
      ['flag-a', 'on', 'user-1'],
      ['flag-b', 'on', 'user-1'],
      ['flag-a', 'off', 'user-1'],
      ['flag-a', 'on', 'user-2'],
      ['flag-a', undefined, 'user-1'],
      ['flag-a', 'on', undefined],
    ]);
  });

  it('records a read of a missing flag (no variation) once per window, without a variation property', () => {
    const { recorder, events } = setup();
    recorder.record('gone', undefined, 'user-1');
    recorder.record('gone', undefined, 'user-1');
    expect(events).toHaveLength(1);
    expect(events[0]).not.toHaveProperty('variation');
  });

  it('starts a new window once the window has elapsed', () => {
    const { recorder, events, advance } = setup(1_000);
    recorder.record('flag-a', 'on', 'user-1');
    advance(999);
    recorder.record('flag-a', 'on', 'user-1');
    expect(events).toHaveLength(1);
    advance(1);
    recorder.record('flag-a', 'on', 'user-1');
    expect(events).toHaveLength(2);
  });

  it('starts a new window if the clock jumps backwards', () => {
    const { recorder, events, advance } = setup();
    recorder.record('flag-a', 'on', 'user-1');
    advance(-60_000); // the user or NTP set the clock back
    recorder.record('flag-a', 'on', 'user-1');
    expect(events).toHaveLength(2);
  });

  it('resetWindow() starts a new window without the clock moving', () => {
    // The page coming back into view resets the window, so a device that slept
    // through the guard's 24 h re-reports its reads as soon as it is used again.
    const { recorder, events } = setup();
    recorder.record('flag-a', 'on', 'user-1');
    recorder.resetWindow();
    recorder.record('flag-a', 'on', 'user-1');
    expect(events).toHaveLength(2);
  });

  it('does not let one user\'s reads suppress another\'s keys that only collide when joined', () => {
    const { recorder, events } = setup();
    recorder.record('a', 'b', 'c|d');
    recorder.record('a', 'b', 'c');
    expect(events).toHaveLength(2);
  });
});
