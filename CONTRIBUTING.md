# Contributing to invisible_dots

Issues and pull requests are welcome.

## Quick links

- **Setup or `doctor` fails?** Open a [setup report](https://github.com/feder-cr/invisible_dots/issues/new?template=01-setup.yml).
- **A Dot, the web UI or the command line misbehaves?** Open a [bug report](https://github.com/feder-cr/invisible_dots/issues/new?template=02-bug.yml).
- **Idea?** Open a [feature request](https://github.com/feder-cr/invisible_dots/issues/new?template=03-feature.yml).
- **Security issue?** Do **not** open a public issue: see [SECURITY.md](SECURITY.md).
- **A site detects or blocks the browser?** That belongs to
  [invisible_playwright](https://github.com/feder-cr/invisible_playwright/issues), the Dot's browser.

## Development

Everything is in [the guide's development section](docs/guide.md#development-and-tests). In short:

```sh
npm ci
npm run typecheck
npm test
git config core.hooksPath .githooks   # the pre-push gate: typecheck, vitest, go test, prose checks
```

The engine (`invisible_engine_dots/`, `pytest`, Linux only) and dot-agentd (`guest/dot-agentd/`, `go test ./...`)
have their own suites; [docs/architecture.md](docs/architecture.md) explains every component.

## Pull requests

1. Branch from `main`; one logical change per PR.
2. Add or update the tests for any change of behaviour. A test that stops running fails CI: the counts are held
   to `.github/test-floors.json`.
3. Write the commit message as the repository does: `area: what is now true`, for example
   `scheduler: a task the claim skipped is claimed when the row is free`.
4. Update the README or `docs/` when what a person sees changes. The README promises nothing it cannot
   support, and CI checks it.
5. Every check must be green before merge.

## License

By contributing, you agree that your contributions are licensed under the MIT License ([LICENSE](LICENSE)).
