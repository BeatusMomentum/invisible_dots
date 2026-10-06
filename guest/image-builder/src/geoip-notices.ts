/**
 * The data inside the golden image that is not ours: the GeoIP database (pins.json `geoip`).
 *
 * `daijro/geoip-all-in-one` merges the free editions of several IP geolocation databases into one file, and each of
 * those is published on the condition that the product using it credits it. The credit lines below are the ones the
 * data sources publish (their own pages, and the READMEs of daijro/geoip-all-in-one, tdulcet/ip-geolocation-dbs and
 * sapics/ip-location-db that list them). They are the one place the wording lives: every golden manifest records
 * them (`notices`), and THIRD_PARTY_NOTICES.md must carry the same text (tests/repo/third-party-notices.test.ts).
 * The last two entries have no publisher's line to copy: CC0 asks for no credit, and the ODbL's own is
 * "(c) OpenStreetMap contributors" (the time zone of an address is computed from its coordinates by tzfpy).
 * The image is built on the host of whoever uses it and is not distributed by this project, so these notices are
 * what a person who runs Dots can read about what the image holds.
 */

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
    source: "GeoFeed + Whois + ASN country database of tdulcet/ip-geolocation-dbs, built from sapics/ip-location-db",
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
