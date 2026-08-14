import { defineConfig } from 'vitest/config';

// Much of this suite is integration work: it loads whole TypeScript programs,
// builds the binary, and spawns it against fixture projects. Vitest's 5s
// default is sized for unit tests, and a shared CI runner is several times
// slower than a laptop — the two heaviest tests take about a second here and
// timed out there. These limits leave room for the slow machine without
// letting a genuine hang run for minutes.
export default defineConfig({
  test: {
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
