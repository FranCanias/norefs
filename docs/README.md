# norefs documentation

Eight pages, one topic each:

- [What norefs finds](checks.md) — every check, the six verdicts, and `--production` mode
- [Configuration](configuration.md) — the config file, boundaries, suppression comments, entry points, monorepos
- [Corpus validation](corpus.md) — a dated regression log of runs on real, widely used repositories
- [Dependencies](dependencies.md) — what counts as using a package, and the misplaced-entry check
- [Fixing automatically](fixing.md) — what `--fix` removes, verifies, refuses, and points out
- [Flags](flags.md) — what every flag and combination does to a working tree, and the exit codes
- [Limitations](limitations.md) — what counts as usage, when norefs stays silent, the remaining blind spots
- [Speed](speed.md) — fast runs with `--only`, the synthetic shapes, and watch mode

The [README](https://github.com/FranCanias/norefs#readme) is the front door,
and the [changelog](https://github.com/FranCanias/norefs/blob/main/CHANGELOG.md) records what each release changed and why.
