# Third-party notices

The MIT license in `LICENSE` covers this repository, except:

- everything under `invisible_engine_dots/`, a hard fork of nanobot, which
  is under `invisible_engine_dots/LICENSE` and the nested notice listed in
  its section below.

That fork, the text this repository's history holds through the earlier
TypeScript engine, and the web client's files that derive from other projects
(each starts with a `Derived from` comment naming its source, and the project
has a section below) come with the notices below. The golden image that
`invisible-dots image build` makes on a host also holds data that is not part
of this repository, the GeoIP database: its credits are in the section "GeoIP
data in the golden image". Nothing under the GPL is installed by default; the
one GPL-3.0 dependency, `libsignal` of the optional WhatsApp client, is left out
of the default install and is described in the section "The opt-in WhatsApp
client and `libsignal` (GPL-3.0)".

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

Two files of the web client derive from nanobot's web UI instead (the
`webui/` of the upstream repository at commit 9dc0aba, under the same license
as above): `apps/web/src/components/chat/activity-step.tsx` and
`apps/web/src/components/channels/qr-connect.tsx`. The first comment of each
says what was changed.

## GeoIP data in the golden image

The browser of a Dot looks up the time zone and the coordinates of its proxy's
address in a GeoIP database when a launch leaves the time zone to `auto`. The
golden image carries one release of it, at a fixed read-only path that the
engine hands the browser through the library's own `STEALTHFOX_GEOIP_MMDB`, so a
launch downloads nothing and asks for no newer release: the file `geoip-aio-all.mmdb.zip` of one release of
`daijro/geoip-all-in-one` (https://github.com/daijro/geoip-all-in-one),
pinned in `guest/image-builder/pins.json` by its URL and SHA-256 and recorded
in each golden manifest as `pinned.geoip`. That project merges the free
editions of the databases below into one file (country codes, coordinates and
a time zone computed from them).

The golden image is built by the person who runs Dots, on their own machine
(`invisible-dots image build` downloads the pinned file to that machine), and
invisible_dots publishes no image and no copy of the data: it does not
redistribute them. What the person holds is governed by the licenses of the
data sources, which are the ones listed below. The merged file has no license
of its own to name: its project declares the GPL-3.0 on its repository, which
is the license of its scripts, and its README states no license for the data it
publishes, only the credits three of its sources ask for. So each source's own
license applies to what it contributed, and the image must not be taken for
GPL-licensed data because GitHub shows a GPL on that repository. Whoever
shares an image or the file with others has to meet the terms below, among them
the share-alike of CC BY-SA 4.0 and the GeoLite2 End User License Agreement.

The credits, source by source, are kept here and in each golden manifest as
`notices`, with the statement above as `notices_statement`
(`guest/image-builder/src/geoip-notices.ts` holds the one list and the one
statement, and a test keeps this section equal to them).

Statement, as the manifest records it:

The GeoIP database in the golden image is the file geoip-aio-all.mmdb of one pinned release of daijro/geoip-all-in-one. It is downloaded and built into the image by the person who runs the build, on their own machine; invisible_dots does not publish or redistribute the image or the data. The file merges the databases listed here, and its project states no license for the merged file (the GPL-3.0 in its repository is the license of its scripts), so each source's own license applies to what it contributed: CC BY-SA 4.0 for IP2Location LITE, IPinfo and IPLocate.io (adaptations must be shared under the same license, with credit), the MaxMind GeoLite2 End User License Agreement, CC BY 4.0 for DB-IP Lite, CC0 1.0, and the ODbL 1.0 for the OpenStreetMap-derived time zone boundaries. Whoever shares the image or the file has to meet all of those terms.

Sources, each under its own data license:

- IP2Location LITE (https://lite.ip2location.com), CC BY-SA 4.0
  (https://creativecommons.org/licenses/by-sa/4.0/): This site or product includes IP2Location LITE data available from https://lite.ip2location.com.
- MaxMind GeoLite2 (https://www.maxmind.com), GeoLite2 End User License Agreement
  (https://www.maxmind.com/en/geolite2/eula): This product includes GeoLite2 Data created by MaxMind, available from https://www.maxmind.com/.
- DB-IP Lite (https://db-ip.com), CC BY 4.0
  (https://creativecommons.org/licenses/by/4.0/): IP Geolocation by DB-IP (https://db-ip.com)
- IPinfo free country database (https://ipinfo.io), CC BY-SA 4.0
  (https://creativecommons.org/licenses/by-sa/4.0/): IP address data powered by IPinfo (https://ipinfo.io)
- IPLocate.io free IP to Country database (https://www.iplocate.io), CC BY-SA 4.0
  (https://creativecommons.org/licenses/by-sa/4.0/): IP address data powered by IPLocate.io (https://www.iplocate.io)
- GeoFeed + Whois + ASN country database of tdulcet/ip-geolocation-dbs, built from sapics/ip-location-db, which lists the same data under PDDL 1.0, CC0 1.0
  (https://creativecommons.org/publicdomain/zero/1.0/): No credit is required; the data comes from tdulcet/ip-geolocation-dbs (https://github.com/tdulcet/ip-geolocation-dbs).
- OpenStreetMap contributors, through the time zone boundaries of timezone-boundary-builder that tzfpy carries, ODbL 1.0
  (https://opendatacommons.org/licenses/odbl/1-0/): Contains time zone data derived from OpenStreetMap, (c) OpenStreetMap contributors (https://www.openstreetmap.org/copyright).

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

## OpenDots (CopilotKit)

`apps/web/src/lib/time.ts`, `apps/web/src/lib/use-visible-interval.ts`,
`apps/web/src/lib/events/tool-labels.ts` and
`apps/web/src/components/tasks/task-status.tsx` derive from OpenDots by CopilotKit
(https://github.com/CopilotKit/OpenDots, commit 88f2a08); each file's first
comment says what was changed.

```text
The MIT License

Copyright (c) Atai Barkai

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.
```

## AI Elements (Vercel)

`apps/web/src/components/chat/conversation.tsx` and
`apps/web/src/components/chat/tool-status.tsx` derive from AI Elements by Vercel
(https://github.com/vercel/ai-elements, commit 6a9d5b1), licensed under the Apache
License, Version 2.0, which is given once, below. Each file's first comment states
what was changed, as the license asks.

```text
Copyright 2023 Vercel, Inc.

                                 Apache License
                           Version 2.0, January 2004
                        http://www.apache.org/licenses/

   TERMS AND CONDITIONS FOR USE, REPRODUCTION, AND DISTRIBUTION

   1. Definitions.

      "License" shall mean the terms and conditions for use, reproduction,
      and distribution as defined by Sections 1 through 9 of this document.

      "Licensor" shall mean the copyright owner or entity authorized by
      the copyright owner that is granting the License.

      "Legal Entity" shall mean the union of the acting entity and all
      other entities that control, are controlled by, or are under common
      control with that entity. For the purposes of this definition,
      "control" means (i) the power, direct or indirect, to cause the
      direction or management of such entity, whether by contract or
      otherwise, or (ii) ownership of fifty percent (50%) or more of the
      outstanding shares, or (iii) beneficial ownership of such entity.

      "You" (or "Your") shall mean an individual or Legal Entity
      exercising permissions granted by this License.

      "Source" form shall mean the preferred form for making modifications,
      including but not limited to software source code, documentation
      source, and configuration files.

      "Object" form shall mean any form resulting from mechanical
      transformation or translation of a Source form, including but
      not limited to compiled object code, generated documentation,
      and conversions to other media types.

      "Work" shall mean the work of authorship, whether in Source or
      Object form, made available under the License, as indicated by a
      copyright notice that is included in or attached to the work
      (an example is provided in the Appendix below).

      "Derivative Works" shall mean any work, whether in Source or Object
      form, that is based on (or derived from) the Work and for which the
      editorial revisions, annotations, elaborations, or other modifications
      represent, as a whole, an original work of authorship. For the purposes
      of this License, Derivative Works shall not include works that remain
      separable from, or merely link (or bind by name) to the interfaces of,
      the Work and Derivative Works thereof.

      "Contribution" shall mean any work of authorship, including
      the original version of the Work and any modifications or additions
      to that Work or Derivative Works thereof, that is intentionally
      submitted to Licensor for inclusion in the Work by the copyright owner
      or by an individual or Legal Entity authorized to submit on behalf of
      the copyright owner. For the purposes of this definition, "submitted"
      means any form of electronic, verbal, or written communication sent
      to the Licensor or its representatives, including but not limited to
      communication on electronic mailing lists, source code control systems,
      and issue tracking systems that are managed by, or on behalf of, the
      Licensor for the purpose of discussing and improving the Work, but
      excluding communication that is conspicuously marked or otherwise
      designated in writing by the copyright owner as "Not a Contribution."

      "Contributor" shall mean Licensor and any individual or Legal Entity
      on behalf of whom a Contribution has been received by Licensor and
      subsequently incorporated within the Work.

   2. Grant of Copyright License. Subject to the terms and conditions of
      this License, each Contributor hereby grants to You a perpetual,
      worldwide, non-exclusive, no-charge, royalty-free, irrevocable
      copyright license to reproduce, prepare Derivative Works of,
      publicly display, publicly perform, sublicense, and distribute the
      Work and such Derivative Works in Source or Object form.

   3. Grant of Patent License. Subject to the terms and conditions of
      this License, each Contributor hereby grants to You a perpetual,
      worldwide, non-exclusive, no-charge, royalty-free, irrevocable
      (except as stated in this section) patent license to make, have made,
      use, offer to sell, sell, import, and otherwise transfer the Work,
      where such license applies only to those patent claims licensable
      by such Contributor that are necessarily infringed by their
      Contribution(s) alone or by combination of their Contribution(s)
      with the Work to which such Contribution(s) was submitted. If You
      institute patent litigation against any entity (including a
      cross-claim or counterclaim in a lawsuit) alleging that the Work
      or a Contribution incorporated within the Work constitutes direct
      or contributory patent infringement, then any patent licenses
      granted to You under this License for that Work shall terminate
      as of the date such litigation is filed.

   4. Redistribution. You may reproduce and distribute copies of the
      Work or Derivative Works thereof in any medium, with or without
      modifications, and in Source or Object form, provided that You
      meet the following conditions:

      (a) You must give any other recipients of the Work or
          Derivative Works a copy of this License; and

      (b) You must cause any modified files to carry prominent notices
          stating that You changed the files; and

      (c) You must retain, in the Source form of any Derivative Works
          that You distribute, all copyright, patent, trademark, and
          attribution notices from the Source form of the Work,
          excluding those notices that do not pertain to any part of
          the Derivative Works; and

      (d) If the Work includes a "NOTICE" text file as part of its
          distribution, then any Derivative Works that You distribute must
          include a readable copy of the attribution notices contained
          within such NOTICE file, excluding those notices that do not
          pertain to any part of the Derivative Works, in at least one
          of the following places: within a NOTICE text file distributed
          as part of the Derivative Works; within the Source form or
          documentation, if provided along with the Derivative Works; or,
          within a display generated by the Derivative Works, if and
          wherever such third-party notices normally appear. The contents
          of the NOTICE file are for informational purposes only and
          do not modify the License. You may add Your own attribution
          notices within Derivative Works that You distribute, alongside
          or as an addendum to the NOTICE text from the Work, provided
          that such additional attribution notices cannot be construed
          as modifying the License.

      You may add Your own copyright statement to Your modifications and
      may provide additional or different license terms and conditions
      for use, reproduction, or distribution of Your modifications, or
      for any such Derivative Works as a whole, provided Your use,
      reproduction, and distribution of the Work otherwise complies with
      the conditions stated in this License.

   5. Submission of Contributions. Unless You explicitly state otherwise,
      any Contribution intentionally submitted for inclusion in the Work
      by You to the Licensor shall be under the terms and conditions of
      this License, without any additional terms or conditions.
      Notwithstanding the above, nothing herein shall supersede or modify
      the terms of any separate license agreement you may have executed
      with Licensor regarding such Contributions.

   6. Trademarks. This License does not grant permission to use the trade
      names, trademarks, service marks, or product names of the Licensor,
      except as required for reasonable and customary use in describing the
      origin of the Work and reproducing the content of the NOTICE file.

   7. Disclaimer of Warranty. Unless required by applicable law or
      agreed to in writing, Licensor provides the Work (and each
      Contributor provides its Contributions) on an "AS IS" BASIS,
      WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or
      implied, including, without limitation, any warranties or conditions
      of TITLE, NON-INFRINGEMENT, MERCHANTABILITY, or FITNESS FOR A
      PARTICULAR PURPOSE. You are solely responsible for determining the
      appropriateness of using or redistributing the Work and assume any
      risks associated with Your exercise of permissions under this License.

   8. Limitation of Liability. In no event and under no legal theory,
      whether in tort (including negligence), contract, or otherwise,
      unless required by applicable law (such as deliberate and grossly
      negligent acts) or agreed to in writing, shall any Contributor be
      liable to You for damages, including any direct, indirect, special,
      incidental, or consequential damages of any character arising as a
      result of this License or out of the use or inability to use the
      Work (including but not limited to damages for loss of goodwill,
      work stoppage, computer failure or malfunction, or any and all
      other commercial damages or losses), even if such Contributor
      has been advised of the possibility of such damages.

   9. Accepting Warranty or Additional Liability. While redistributing
      the Work or Derivative Works thereof, You may choose to offer,
      and charge a fee for, acceptance of support, warranty, indemnity,
      or other liability obligations and/or rights consistent with this
      License. However, in accepting such obligations, You may act only
      on Your own behalf and on Your sole responsibility, not on behalf
      of any other Contributor, and only if You agree to indemnify,
      defend, and hold each Contributor harmless for any liability
      incurred by, or claims asserted against, such Contributor by reason
      of your accepting any such warranty or additional liability.

   END OF TERMS AND CONDITIONS

   Copyright 2022 Joe Bell

   Licensed under the Apache License, Version 2.0 (the "License");
   you may not use this file except in compliance with the License.
   You may obtain a copy of the License at

       http://www.apache.org/licenses/LICENSE-2.0

   Unless required by applicable law or agreed to in writing, software
   distributed under the License is distributed on an "AS IS" BASIS,
   WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
   See the License for the specific language governing permissions and
   limitations under the License.
```

## open-cowork

`apps/web/src/components/computer/screen-view.tsx` derives from open-cowork by
Coasty (https://github.com/coasty-ai/open-cowork, commit fbbc671); its first comment
says what was changed. No asset of that project is used.

```text
MIT License

Copyright (c) 2026 Coasty / open-cowork contributors

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

## assistant-ui

`apps/web/src/components/elements/approval-card.tsx`,
`schedule-card.tsx` and `memory-chips.tsx` in the same folder, and
`apps/web/src/lib/range.ts` derive from assistant-ui
(https://github.com/assistant-ui/assistant-ui, commit 0bdf050); each file's first
comment says what was changed.

```text
MIT License

Copyright (c) 2026 AgentbaseAI Inc.

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

## OpenDots (Shashankss1205)

`apps/web/src/components/approvals/diff-preview.tsx` and
`apps/web/src/lib/diff.ts` derive from OpenDots by Shashank Shekhar Singh
(https://github.com/Shashankss1205/OpenDots, commit bb8db95), which includes source
previously distributed under the name Spots (Copyright (c) 2026 Spots contributors,
also MIT); each file's first comment says what was changed. No other project of the
same name is meant: the CopilotKit one has its own section above.

```text
MIT License

Copyright (c) 2026 Shashank Shekhar Singh

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

## The opt-in WhatsApp client and `libsignal` (GPL-3.0)

Nothing under the GPL is installed by default. The WhatsApp adapter
(`packages/channels/src/whatsapp-baileys/`) uses Baileys (MIT), a client of the
WhatsApp Web protocol, which depends on the npm package `libsignal`, under the
GNU General Public License, version 3, and so does not fit this repository's MIT
license. They are therefore not part of the default install:

- No workspace declares Baileys, as a dependency of any kind, and the root
  `package-lock.json` holds none of it or of what only it needs, so `npm ci`
  installs no GPL package (`tests/repo/default-install-licenses.test.ts` scans
  the lock file for licenses).
- The client lives apart, in `optional/whatsapp/`, with a `package.json` that
  pins Baileys to one exact release and a `package-lock.json` with the
  integrity hash of every package. A person who turns WhatsApp on installs it
  with one command from the repository root: `npm run whatsapp:install` (a
  clean install of that lock file, without install scripts). Installing it is
  that person's choice, and what they then hold, Baileys and `libsignal`,
  is under those licenses.
- The adapter loads the client from that folder, by path, only when a
  connection opens and only if it is there. Otherwise it says how to enable it:
  run `npm run whatsapp:install`, then start the server with
  `INVISIBLE_DOTS_WHATSAPP=1`.
- The command bundle that `apps/cli/scripts/build.mjs` makes does not hold it
  (the bundle has no import of it), so no build of this repository is a GPL
  work. Whoever distributes a build together with an installed
  `optional/whatsapp/node_modules`, which is GPL-3.0 code, has to take that into
  account.

## LGPL image libraries that Next.js may install

The web client's framework, Next.js, lists `sharp` (an image library,
Apache-2.0) as an optional dependency, and `sharp` lists prebuilt binaries for
each platform, `@img/sharp-*` and `@img/sharp-libvips-*`, which carry libvips
under the LGPL-3.0 (`LGPL-3.0-or-later`, or `Apache-2.0 AND LGPL-3.0-or-later`
for the Windows builds). `npm ci` installs the ones that fit the host, as
optional packages. They are LGPL, not GPL, and unmodified; whoever distributes
an installation together with its `node_modules` has to meet the LGPL for them.
`tests/repo/default-install-licenses.test.ts` allows no LGPL package in the lock
file other than these.
