// Deliberate benchmark. Never run in CI — timing assertions are flaky on
// shared runners and train people to ignore red builds. Compare against the
// figures in BUILD.md §10: 27 ms @2x, 55 ms @3x, 93 ms for a full pass.
import { renderStrip } from '../src/strip.ts';
import { MemoryStore, cachedStrip } from '../src/stripCache.ts';
import { renderAllDensities } from '../src/densities.ts';

const spec = {
  goal: 8, filled: 3, shape: 'circle',
  bgColor: '#203757', bgOpacity: 1,
  activeColor: '#F96400', inactiveColor: '#8794A5',
};

function time(label, fn, runs = 20) {
  fn();
  const t0 = performance.now();
  for (let i = 0; i < runs; i++) fn();
  const ms = (performance.now() - t0) / runs;
  console.log(`${label.padEnd(34)} ${ms.toFixed(1)} ms`);
  return ms;
}

time('strip @2x', () => renderStrip({ ...spec, scale: 2 }));
time('strip @3x', () => renderStrip({ ...spec, scale: 3 }));

const uncached = time('full pass, three densities', () => {
  renderStrip({ ...spec, scale: 1 });
  renderStrip({ ...spec, scale: 2 });
  renderStrip({ ...spec, scale: 3 });
});

const store = new MemoryStore();
await renderAllDensities(store, spec);
const t0 = performance.now();
for (let i = 0; i < 5000; i++) await cachedStrip(store, { ...spec, scale: 3 });
const cachedTotal = performance.now() - t0;

console.log('');
console.log(`5,000 cached fetches               ${cachedTotal.toFixed(0)} ms`);
console.log(`same uncached would be roughly     ${((uncached * 5000) / 1000).toFixed(0)} s`);
