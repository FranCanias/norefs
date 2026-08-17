# Security

## Supported versions

The latest published release. norefs is a single-package project with one
maintainer, so a fix ships as a new version rather than a backport.

## Reporting a vulnerability

Report privately through GitHub:
[open a security advisory](https://github.com/FranCanias/norefs/security/advisories/new).
Please do not open a public issue for a vulnerability.

Tell us what you ran, what happened, and what you expected. A repository or a
small project that reproduces it is worth more than any description.

You will get a first reply within seven days. If the report holds up, the fix
and the advisory go out together, and the advisory credits you unless you ask
otherwise.

## What norefs does on your machine

Worth knowing before you read a report as a vulnerability:

- It reads your project's source, `tsconfig.json`, `package.json`, and the tool
  configs it names in [docs/configuration.md](docs/configuration.md).
- It writes only when you ask: `--fix` edits source files, `--baseline` and the
  report flags write their own files.
- It runs two commands, and only two: `git status --porcelain`, to warn you
  before `--fix` edits a dirty tree, and whatever you pass to
  `--verify-command`.
- It makes no network request, ever.

A finding that norefs reads a file outside the analyzed project, writes without
a writing flag, or reaches the network is a security bug. Please report it.
