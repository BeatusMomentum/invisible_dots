/**
 * The data inside the golden image that is not ours: the GeoIP database (pins.json `geoip`).
 *
 * The file is `geoip-aio-all.mmdb` of one release of `daijro/geoip-all-in-one`, which merges the free editions of
 * several IP geolocation databases (country codes, coordinates, and a time zone computed from the coordinates), and
 * each of those is published under its own data license, most of them on the condition that the product using it
 * credits the publisher. `GEOIP_NOTICES` lists them with the license and the credit line each publisher asks for (the
 * publisher's own page, and the READMEs of daijro/geoip-all-in-one, tdulcet/ip-geolocation-dbs and
 * sapics/ip-location-db that list them). They are the one place the wording lives: every golden manifest records
 * them (`notices`) with `GEOIP_STATEMENT` (`notices_statement`), and THIRD_PARTY_NOTICES.md must carry the same text
 * (tests/repo/third-party-notices.test.ts).
 *
 * What the list does not hold is a license for the merged file itself, because there is none to name:
 * daijro/geoip-all-in-one carries a GPL-3.0 LICENSE file, which is the license of its scripts, and its README states
 * no license for the data it publishes, only the credits three of its sources ask for. So the data licenses are
 * the sources', and the statement says so, instead of calling the file GPL because GitHub shows that license on the
 * repository. The last two entries have no publisher's line to copy: CC0 asks for no credit, and the ODbL's own is
 * "(c) OpenStreetMap contributors" (the time zone of an address is computed from its coordinates by tzfpy).
 *
 * The image is built by the person who runs Dots, on their own machine, from the pinned release that their machine
 * downloads; invisible_dots publishes no image and no copy of the data, so it does not redistribute it. These notices
 * are what a person who runs Dots can read about what the image holds, and what they owe if they share it.
 */

/** What the golden manifest and THIRD_PARTY_NOTICES.md say about the GeoIP data as a whole, next to the per-source list. */
export const GEOIP_STATEMENT =
  "The GeoIP database in the golden image is the file geoip-aio-all.mmdb of one pinned release of daijro/geoip-all-in-one. It is downloaded and built into the image by the person who runs the build, on their own machine; invisible_dots does not publish or redistribute the image or the data. The file merges the databases listed here, and its project states no license for the merged file (the GPL-3.0 in its repository is the license of its scripts), so each source's own license applies to what it contributed: CC BY-SA 4.0 for IP2Location LITE, IPinfo and IPLocate.io (adaptations must be shared under the same license, with credit), the MaxMind GeoLite2 End User License Agreement, CC BY 4.0 for DB-IP Lite, CC0 1.0, and the ODbL 1.0 for the OpenStreetMap-derived time zone boundaries. Whoever shares the image or the file has to meet all of those terms.";

export interface DataNotice {
  /** What in the image the data is part of. */
  component: "geoip";
  /** Who publishes the data. */
  source: string;
  license: string;
  license_url: string;
  /** The credit the license or the publisher asks for: the publisher's own line where it gives one. */
  attribution: string;
}

export const GEOIP_NOTICES: readonly DataNotice[] = [
  {
    component: "geoip",
    source: "IP2Location LITE (https://lite.ip2location.com)",
    license: "CC BY-SA 4.0",
    license_url: "https://creativecommons.org/licenses/by-sa/4.0/",
    attribution: "This site or product includes IP2Location LITE data available from https://lite.ip2location.com.",
  },
  {
    component: "geoip",
    source: "MaxMind GeoLite2 (https://www.maxmind.com)",
    license: "GeoLite2 End User License Agreement",
    license_url: "https://www.maxmind.com/en/geolite2/eula",
    attribution: "This product includes GeoLite2 Data created by MaxMind, available from https://www.maxmind.com/.",
  },
  {
    component: "geoip",
    source: "DB-IP Lite (https://db-ip.com)",
    license: "CC BY 4.0",
    license_url: "https://creativecommons.org/licenses/by/4.0/",
    attribution: "IP Geolocation by DB-IP (https://db-ip.com)",
  },
  {
    component: "geoip",
    source: "IPinfo free country database (https://ipinfo.io)",
    license: "CC BY-SA 4.0",
    license_url: "https://creativecommons.org/licenses/by-sa/4.0/",
    attribution: "IP address data powered by IPinfo (https://ipinfo.io)",
  },
  {
    component: "geoip",
    source: "IPLocate.io free IP to Country database (https://www.iplocate.io)",
    license: "CC BY-SA 4.0",
    license_url: "https://creativecommons.org/licenses/by-sa/4.0/",
    attribution: "IP address data powered by IPLocate.io (https://www.iplocate.io)",
  },
  {
    component: "geoip",
    source: "GeoFeed + Whois + ASN country database of tdulcet/ip-geolocation-dbs, built from sapics/ip-location-db, which lists the same data under PDDL 1.0",
    license: "CC0 1.0",
    license_url: "https://creativecommons.org/publicdomain/zero/1.0/",
    attribution: "No credit is required; the data comes from tdulcet/ip-geolocation-dbs (https://github.com/tdulcet/ip-geolocation-dbs).",
  },
  {
    component: "geoip",
    source: "OpenStreetMap contributors, through the time zone boundaries of timezone-boundary-builder that tzfpy carries",
    license: "ODbL 1.0",
    license_url: "https://opendatacommons.org/licenses/odbl/1-0/",
    attribution: "Contains time zone data derived from OpenStreetMap, (c) OpenStreetMap contributors (https://www.openstreetmap.org/copyright).",
  },
];
