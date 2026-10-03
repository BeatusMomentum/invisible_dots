# Upstream of the engine

Parts of `guest-runtime/engine/` are derived from Open Multi-Agent, under the
MIT license in `LICENSE` next to this file. This file is the one place that
records where they came from. The copy is ours from here on: it is changed as
much as the Dot needs and is never synced with upstream again.

## Source

| | |
|---|---|
| project | Open Multi-Agent, <https://github.com/open-multi-agent/open-multi-agent> |
| package | `@open-multi-agent/core` 1.21.1 |
| commit | `3563a9312b304fffca49873c0dcf6c3b259a0f58` (2026-10-03 00:26 +08:00, "chore: release core v1.21.1 and create-oma-app v0.8.8 (#621)") |
| tree of `packages/core/src` | `3332a248e6baab86c3eaaabf34c26908b3dd53a5` |
| tree of `packages/core/tests` | `0a920a4d68974380436e6f7f2278ae31c546fc43` (not imported) |
| `LICENSE` | blob `31f4e3eb40fecbc73d1a14a7f3cda0de278f1069`, SHA-256 `cd3977e512c4511479c9b9fa0655050d6ee74f6a497ec6f0300272936c5a4da4` |
| npm | the published package of the same version; it carries the built `dist`, not `src`, so the import is taken from the commit above |

Upstream tags its releases (`v1.21.0` is `ab349e7`), but there is no tag for
1.21.1; the commit above is the release commit of that version.

## What was imported

Only the files the Dot's engine is built from, byte for byte from the git
objects of the commit above (LF line ends), under `src/` with upstream's
paths below `packages/core/src/`:

| file | upstream blob |
|---|---|
| `agent/runner.ts` | `17da5cd85502c8f4c9abbd843e578baca5903c13` |
| `agent/agent.ts` | `694f619aaa5ba41d40cb6caf4451a1ab0d55ac79` |
| `agent/loop-detector.ts` | `e04af225eeb21f6920c2192b90a8d2f5912d544f` |
| `tool/executor.ts` | `a9126b0a06bd8de459dd0189f19e45f284d3fdca` |
| `tool/framework.ts` | `ccf567c92ad272aaf04f19f360cd6e8ca13fb039` |
| `tool/result.ts` | `e41e0cd0dd72cea42f5bebdf342c5f0913bc1cbe` |
| `approval/durable.ts` | `210fea0cd38a44171818a811e270cc67dd57a828` |
| `memory/checkpoint.ts` | `168c6eb284cfa90c9e6017da60cfa890781340e8` |
| `memory/store.ts` | `72f2ad58732140b215b73da46c6d83ec01181eb2` |
| `run/ledger.ts` | `ff851d506265bcdffb870ad042711301c70318cb` |
| `run/record.ts` | `87c1b023a21b6c09ed661c91d6ee7d83abc2f7c4` |
| `run/store.ts` | `d0cb1090af17c416b8668272dc997a9e61877313` |
| `run/index.ts` | `c1f2cc5efb8e29552a0f5ae18aaa680b0961cb8a` |
| `orchestrator/orchestrator.ts` | `72d4a3487919c8df31599d8541b9a56637c0a489` |
| `orchestrator/task-execution.ts` | `e45ce3b5ec93d174ce8ff1be6f7a8cabf08bfbd4` |
| `orchestrator/run-context.ts` | `dea6c528712c1068709fa2b4fa445bdab1e4d9e8` |
| `orchestrator/recovery.ts` | `5761e5b23ea65fd1cd9f2b61ca1c0fce9e22f097` |
| `task/queue.ts` | `e694f240d2b2905539c06b17c4c08d7d101f3bd6` |
| `task/task.ts` | `72beb48dc606782552b1b57da6f3ed5419c79a18` |
| `types.ts` | `33dc224645b7ad7be08ab87fd989e100f10e37df` |
| `errors.ts` | `95cf43a210246acb98bab12267310fda7555a190` |
| `utils/abort.ts` | `3e5e19d4a02e2a340ff184577006ffc9cb17d2bb` |
| `utils/tokens.ts` | `dc5e679d5744dc1e6eaa4c9350875638113619fc` |

Not imported: the providers, teams, sub-agents, the run journal, evaluation,
telemetry, the CLI and dashboard, upstream's tests, `package.json`,
`AGENTS.md` and `CLAUDE.md`. Where a kept module needs a test, the test is
written here against this repository's types, not copied.

## Ported later

Nothing outside the list above is planned. A later need for sub-agents, teams
or another provider starts from the commit above, in a change of its own.

## Third-party text inside the imported files

`agent/runner.ts` as published contains two functions modelled on
`@context-chef/core` 4.2.1 (MIT, Copyright (c) 2025 MyPrototypeWhat):
`groupIntoTurns`, which matches that library's function in name, return shape
and loop, and `stripMediaBlocksForSummary`, whose comment says it is modelled
on the library's `stripAttachmentsForCompression`. Because this repository's
history contains them, `THIRD_PARTY_NOTICES.md` at the repository root carries
context-chef's MIT notice.
