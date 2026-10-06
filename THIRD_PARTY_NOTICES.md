# Third-party notices

The MIT license in `LICENSE` covers this repository, except:

- everything under `invisible_engine_dots/`, a hard fork of nanobot, which
  is under `invisible_engine_dots/LICENSE` and the nested notice listed in
  its section below.

That fork, the text this repository's history holds through the earlier
TypeScript engine, and the web client's files that derive from other projects
(each starts with a `Derived from` comment naming its source, and the project
has a section below) come with the notices below.

## Open Multi-Agent

The earlier TypeScript engine (`guest-runtime/engine/`) was derived in part
from it. That engine is deleted; its files and its `UPSTREAM.md` (source,
version and commit) are in this repository's history, before the commit
"repo: delete the earlier TypeScript engine and agent", and this notice stays
for as long as that history does.

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
into this repository's history, contained `groupIntoTurns` and
`stripMediaBlocksForSummary`, modelled on this library (the deleted engine's
`UPSTREAM.md` records the details).

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

## nanobot

`invisible_engine_dots/` is imported from nanobot
(https://github.com/HKUDS/nanobot, commit
`f75470e72f0993dcf92accc81282adaa48b16f56`) and modified for invisible_dots.
It is a hard fork: upstream changes are not tracked or merged. Source, commit,
what the import left out and what was removed since:
`invisible_engine_dots/UPSTREAM.md`. Its
`LICENSE`, byte for byte:

```text
MIT License

Copyright (c) 2025-present Xubin Ren and the nanobot contributors

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

The fork carries one further notice, which stays next to the code it covers:

- `invisible_engine_dots/THIRD_PARTY_NOTICES.md`: says that no third-party
  component is vendored in the fork.

Its Python dependencies are not part of this repository: the golden image's
build installs them from PyPI as the wheels their publishers released, pinned
by hash in `guest/image-builder/builder/engine-requirements.lock`, each under
its own license. The runtime disk carries the fork's own source with its
`LICENSE` and `UPSTREAM.md` (`/opt/invisible-dots/engine/` in the guest).

## shadcn/ui

The primitives in `apps/web/src/components/ui/` and `apps/web/src/lib/utils.ts`
were generated from shadcn/ui (https://github.com/shadcn-ui/ui, commit
0e3abd65) and changed; each file's first comment says what changed.

```text
MIT License

Copyright (c) 2023 shadcn

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
