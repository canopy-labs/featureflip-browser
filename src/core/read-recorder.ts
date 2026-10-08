/**
 * An `Evaluation` event as `POST /v1/client/events` accepts it. `variation` is
 * unset when the flag was absent from the snapshot (the read still counts:
 * code asking for a flag is exactly what the archive guard must see).
 */
export interface EvaluationReadEvent {
  type: 'Evaluation';
  flagKey: string;
  variation?: string;
  userId?: string;
  timestamp: string;
}

/**
 * One hour. The server's rollups are hourly buckets and the archive guard looks
 * back 24 hours, so re-reporting a read once an hour loses nothing either needs,
 * while bounding a long-lived tab to one event per (flag, variation, user) per hour.
 */
export const READ_DEDUPE_WINDOW_MS = 3_600_000;

/**
 * Turns flag reads into at most one event per (flag, variation, user) per
 * window. The window is timed on wall time (Date.now), not performance.now:
 * the latter can pause while the device sleeps, and a window stretched across
 * a long sleep would stop re-reporting a flag the page still reads past the
 * archive guard's 24 h. resetWindow() (on the page becoming visible) and the
 * backwards-jump check close the remaining gaps.
 *
 * This sits on the hottest path in the SDK: React's useSyncExternalStore calls
 * getSnapshot, and so a variation, on every render. So a repeat read must cost three Map/Set lookups and nothing else: no string
 * building, no allocation, no I/O. Only a first read in a window allocates.
 *
 * @internal
 */
export class ReadRecorder {
  /** userId ('' when none) → flagKey → variations ('' when none) seen this window. */
  private seen = new Map<string, Map<string, Set<string>>>();
  private windowStart: number;

  constructor(
    private readonly sink: (event: EvaluationReadEvent) => void,
    private readonly windowMs: number = READ_DEDUPE_WINDOW_MS,
    private readonly now: () => number = Date.now,
  ) {
    this.windowStart = now();
  }

  /** Forget this window's reads and start a new one now. */
  resetWindow(): void {
    this.seen = new Map();
    this.windowStart = this.now();
  }

  record(flagKey: string, variation: string | undefined, userId: string | undefined): void {
    const t = this.now();
    if (t - this.windowStart >= this.windowMs || t < this.windowStart) {
      this.seen = new Map();
      this.windowStart = t;
    }

    const userKey = userId ?? '';
    const variationKey = variation ?? '';

    let byFlag = this.seen.get(userKey);
    if (byFlag === undefined) {
      byFlag = new Map();
      this.seen.set(userKey, byFlag);
    }
    let variations = byFlag.get(flagKey);
    if (variations === undefined) {
      variations = new Set();
      byFlag.set(flagKey, variations);
    } else if (variations.has(variationKey)) {
      return; // the hot path: a repeat read
    }
    variations.add(variationKey);

    const event: EvaluationReadEvent = {
      type: 'Evaluation',
      flagKey,
      timestamp: new Date(t).toISOString(),
    };
    if (variation !== undefined) event.variation = variation;
    if (userId !== undefined) event.userId = userId;
    this.sink(event);
  }
}
