## What this changes, and why

<!-- The why is the part `git log` cannot reconstruct later. -->

## What was checked

<!--
Not what should hold — what you ran. A behaviour change needs a test that
fails without it. A new check needs a note in docs/corpus.md.
-->

- [ ] `pnpm check`, `pnpm typecheck`, `pnpm build`, `pnpm test`
- [ ] `node dist/index.js` at the repository root still finds nothing
- [ ] Docs updated in all three places, if a flag changed: the README table,
      the `HELP` string, and `docs/flags.md`
