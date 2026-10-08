// Repeat-read benchmark for flag-read reporting (#3545). Dependency-free:
// vitest 5 dropped `bench`, so this is one vitest test that times the loop.
// Not matched by `vitest run` (CI); run it with exactly:
//   cd packages/browser-sdk && npx vitest bench --run --silent=false src/__bench__/read-path.bench.ts
// and read the "RESULT" line (median ns/op over ROUNDS, on vs off).
import { test } from 'vitest';
import { SharedFeatureflipCore } from '../core/shared-core';

const WARMUP = 100_000;
const CALLS = 1_000_000;
const ROUNDS = 7;

// Cores are never initialized: no network, and the processor never starts.
// After the first read, every boolVariation below is a dedupe hit, which is
// exactly the repeat-read path React exercises on every render.
const on = new SharedFeatureflipCore({ clientKey: 'bench-on', context: { user_id: 'u1' } });
const off = new SharedFeatureflipCore({ clientKey: 'bench-off', context: { user_id: 'u1' }, sendEvaluationEvents: false });

function timeNsPerOp(core: SharedFeatureflipCore): number {
  const start = performance.now();
  for (let i = 0; i < CALLS; i++) core.boolVariation('flag', false);
  return ((performance.now() - start) * 1e6) / CALLS;
}

const median = (xs: number[]): number => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];

test('repeat-read benchmark: reporting on vs off', () => {
  on.boolVariation('flag', false);
  for (let i = 0; i < WARMUP; i++) {
    on.boolVariation('flag', false);
    off.boolVariation('flag', false);
  }
  const onRuns: number[] = [];
  const offRuns: number[] = [];
  for (let r = 0; r < ROUNDS; r++) {
    // Alternate order each round so neither core always runs second.
    if (r % 2 === 0) {
      offRuns.push(timeNsPerOp(off));
      onRuns.push(timeNsPerOp(on));
    } else {
      onRuns.push(timeNsPerOp(on));
      offRuns.push(timeNsPerOp(off));
    }
  }
  const offNs = median(offRuns);
  const onNs = median(onRuns);
  console.log(`off rounds (ns/op): ${offRuns.map((x) => x.toFixed(1)).join(', ')}`);
  console.log(`on  rounds (ns/op): ${onRuns.map((x) => x.toFixed(1)).join(', ')}`);
  console.log(`RESULT off=${offNs.toFixed(1)}ns/op on=${onNs.toFixed(1)}ns/op delta=${(onNs - offNs).toFixed(1)}ns (budget 100ns)`);
}, 120_000);
