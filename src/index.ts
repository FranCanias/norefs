#!/usr/bin/env node
import './compile-cache';
import { main } from './cli';

// The tarball ships sourcemaps so a stack trace in a bug report names src/
// lines — but only if the runtime is told to read them.
process.setSourceMapsEnabled(true);

main();
