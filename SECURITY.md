# Security Policy

## Supported versions

Only `main` receives fixes: nothing is packaged yet, and you build from this repository.

## Reporting a vulnerability

Do not report security issues in public issues, discussions or pull requests.

Send a report to `federico.elia.majo@gmail.com` with the subject prefix `[security][invisible_dots]`, with:

- what the issue is and what it affects
- the steps to reproduce
- the commit (`git rev-parse --short HEAD`), the host OS and `invisible-dots doctor --json`
- a fix, if you have one

What a Dot is and is not protected against is written down in
[the guide's security model](docs/guide.md#security-model-and-known-limits): a way around one of those guarantees
is in scope.

## Scope

In scope:

- The control plane: API, scheduler, VM manager, database, web client and command line
- The guest: dot-agentd, the engine and the separation between them and the Dot's user
- The images and how they are built and downloaded

Out of scope:

- The Dot's browser: report to [invisible_playwright_mcp](https://github.com/feder-cr/invisible_playwright_mcp) or
  [invisible_playwright](https://github.com/feder-cr/invisible_playwright)
- QEMU, Firefox and other upstream projects: report to them directly

Not security issues:

- A site detecting or blocking the browser: open a regular issue in
  [invisible_playwright](https://github.com/feder-cr/invisible_playwright/issues)
- What a model chooses to do with permissions you set to allow
