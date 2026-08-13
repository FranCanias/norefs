import module from 'node:module';

// Cache V8 bytecode between runs. The TypeScript bundle alone is ~10 MB of
// source, and parsing plus compiling it costs a few hundred milliseconds on
// every start. Imported before anything that pulls the bundle in.
try {
  module.enableCompileCache?.();
} catch {
  // A read-only install directory just means no cache.
}
