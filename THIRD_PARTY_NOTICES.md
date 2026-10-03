# Third-party notices

The MIT license in `LICENSE` covers this repository, except the files under
`guest-runtime/engine/` that carry the Open Multi-Agent header, which are
under `guest-runtime/engine/LICENSE`. Those files, and the text this
repository's history holds through them, come with the notices below.

The guest agent is shipped as one bundled file. Its build writes
`THIRD_PARTY_NOTICES.txt` next to the bundle, with the license texts of
every npm package it carries, and the runtime disk carries that file next to
the agent.

## Open Multi-Agent

Derived files: those under `guest-runtime/engine/src/` whose first lines say
so. Source, version and commit: `guest-runtime/engine/UPSTREAM.md`.

```text
MIT License

Copyright (c) Shenzhen YuanASI Technology Co., Ltd. and open-multi-agent contributors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## context-chef

`@context-chef/core` 4.2.1. Open Multi-Agent's `agent/runner.ts`, as imported
into this repository's history, contains `groupIntoTurns` and
`stripMediaBlocksForSummary`, modelled on this library
(`guest-runtime/engine/UPSTREAM.md` records the details).

```text
MIT License

Copyright (c) 2025 MyPrototypeWhat

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
