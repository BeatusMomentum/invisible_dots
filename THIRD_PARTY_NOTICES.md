# Third-party notices

The MIT license in `LICENSE` covers this repository, except:

- everything under `invisible_engine_dots/`, a hard fork of nanobot, which
  is under `invisible_engine_dots/LICENSE` and the nested notice listed in
  its section below.

That fork, and the text this repository's history holds through the earlier
TypeScript engine, come with the notices below. The golden image that
`invisible-dots image build` makes on a host also holds data that is not part
of this repository, the GeoIP database: its credits are in the section "GeoIP
data in the golden image".

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
a time zone computed from them), and each of them is published on the
condition that the product using it credits it. The image is built on the host
of whoever runs Dots and this repository does not distribute it or the data;
the credits are kept here, and in each golden manifest as `notices`
(`guest/image-builder/src/geoip-notices.ts` holds the one list, and a test
keeps this section equal to it). Each source's license governs its own data;
the merged file is published by `daijro/geoip-all-in-one` under the GPL-3.0, the
first entry below (its repository declares that license, and the pinned release
is the file it publishes).

- daijro/geoip-all-in-one (https://github.com/daijro/geoip-all-in-one), which merges the databases below and publishes the file the image carries, GPL-3.0
  (https://www.gnu.org/licenses/gpl-3.0.html): The file geoip-aio-all.mmdb is published by daijro/geoip-all-in-one (https://github.com/daijro/geoip-all-in-one) under the GPL-3.0.
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
- GeoFeed + Whois + ASN country database of tdulcet/ip-geolocation-dbs, built from sapics/ip-location-db, CC0 1.0
  (https://creativecommons.org/publicdomain/zero/1.0/): No credit is required; the data comes from tdulcet/ip-geolocation-dbs (https://github.com/tdulcet/ip-geolocation-dbs).
- OpenStreetMap contributors, through the time zone boundaries of timezone-boundary-builder that tzfpy carries, ODbL 1.0
  (https://opendatacommons.org/licenses/odbl/1-0/): Contains time zone data derived from OpenStreetMap, (c) OpenStreetMap contributors (https://www.openstreetmap.org/copyright).
