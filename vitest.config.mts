import { defineConfig } from 'vitest/config';

// Much of this suite is integration work: it loads whole TypeScript programs,
// builds the binary, and spawns it against fixture projects. Vitest's 5s
// default is sized for unit tests, and a shared CI runner is several times
// slower than a laptop — the two heaviest tests take about a second here and
// timed out there. These limits leave room for the slow machine without
// letting a genuine hang run for minutes.
export default defineConfig({
  test: {
    // Only the suite's own files: a stray *.test.ts inside a fixture directory
    // must never be collected as a test.
    include: ['tests/*.test.ts'],
    // Pinned, not defaulted: ts-morph holds gigabytes per worker and several
    // suites spawn child processes — a future default flip to threads would
    // break both quietly.
    pool: 'forks',
    globalSetup: ['./tests/global-setup.ts'],
    testTimeout: 30_000,
    hookTimeout: 60_000,
    // Reported, never gated. The number's job is to name the source files no
    // test reaches; a threshold would only invite tests written to raise it.
    // It reads low on purpose: cli.test.ts and smoke.test.ts spawn the built
    // binary, and a child process is outside this instrumentation.
    coverage: {
      provider: 'v8',
      reporter: ['text-summary', 'text'],
      include: ['src/**/*.ts'],
      // Excluded so the number means what the comment above says: types/ has
      // no statements to cover, and the bin shim and compile cache run only
      // inside spawned children, which V8 coverage cannot see.
      exclude: ['src/types/**', 'src/index.ts', 'src/compile-cache.ts'],
    },
  },
});
