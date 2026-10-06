# Third-party notices

The MIT license in `LICENSE` covers this repository, except:

- everything under `invisible_engine_dots/`, a hard fork of nanobot, which
  is under `invisible_engine_dots/LICENSE` and the nested notice listed in
  its section below.

That fork, and the text this repository's history holds through the earlier
TypeScript engine, come with the notices below. The golden image that
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
