/**
 * The NoCloud seed of a Dot (architecture sections 3.2 and 4.2): user-data and
 * meta-data rendered from virtualization/cloud-init/ and written as an ISO
 * labelled "cidata" by packages/iso. The templates on disk are the single
 * source of the content; this module fills them in, quoting every value as a
 * YAML scalar.
 */
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { writeIso } from "@invisible-dots/iso";
import type { GuestBootConfig } from "@invisible-dots/shared";

/** `virtualization/` of this repository, found relative to this file. */
export const DEFAULT_VIRTUALIZATION_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../../../virtualization");

/** cloud-init's NoCloud datasource looks for a filesystem with this label. */
export const SEED_VOLUME_ID = "cidata";

/** Volume label of the runtime ISO; the image builder writes it, the seed mounts by it. */
export const RUNTIME_ISO_LABEL = "IDOTS-RT";

/**
 * Every date inside the seed image. A fixed value makes the image a pure
 * function of its content, so writing the same seed twice gives the same bytes.
 */
export const SEED_TIMESTAMP = new Date("2026-01-01T00:00:00Z");

/**
 * A YAML double-quoted scalar. JSON string syntax is a subset of YAML's
 * double-quoted style, so JSON.stringify is a correct encoder here.
 */
export function yamlScalar(value: string): string {
  return JSON.stringify(value);
}

/**
 * Replace each `{{name}}` with `encode(values[name])`. A placeholder without a
 * value is an error: an empty value in a seed is a broken VM that cloud-init
 * would accept.
 */
export function renderTemplate(template: string, values: Record<string, string | number>, encode: (value: string) => string): string {
  return template.replace(/\{\{\s*([A-Za-z][A-Za-z0-9_]*)\s*\}\}/g, (_match, name: string) => {
    const value = values[name];
    if (value === undefined) throw new Error(`template placeholder "${name}" has no value`);
    return encode(String(value));
  });
}

/** The guest hostname. Dot ids contain "_", which is not valid in a hostname, so it becomes "-". */
export function guestHostname(dotId: string): string {
  return `invisible-dot-${dotId.replace(/_/g, "-")}`;
}

export interface SeedTemplates {
  userData: string;
  metaData: string;
}

export interface SeedFiles {
  userData: string;
  metaData: string;
  instanceId: string;
  /** The digest of the rendered content, which the next seed is compared with. */
  digest: string;
}

/** The seed written last for a Dot: its content's digest and its instance-id (seed-instance.json beside seed.iso). */
export interface PreviousSeed {
  digest: string;
  instanceId: string;
}

/**
 * Render the seed of one Dot.
 *
 * cloud-init runs its per-instance modules (users, write_files, mounts...)
 * once per instance-id it has not run them for. Rewriting the seed the last
 * one was (a retried create, a restart) keeps that seed's id and re-runs
 * nothing. A seed that differs from the last one (a new token, a VM proxy set
 * or cleared, new templates) gets an id cloud-init has never seen: one derived
 * from the content alone would come back with the content (a proxy cleared
 * gives the first boot's seed again, whose modules ran long ago), and the old
 * config.json would stay. So a changed seed's id also covers the id before it.
 */
export function renderSeed(templates: SeedTemplates, dotId: string, token: string, proxy?: string, previous?: PreviousSeed): SeedFiles {
  const bootConfig: GuestBootConfig = { dotId, token, ...(proxy ? { proxy } : {}) };
  const hostname = guestHostname(dotId);
  const userData = renderTemplate(
    templates.userData,
    {
      hostname,
      bootConfigJson: `${JSON.stringify(bootConfig)}\n`,
      runtimeDevice: `LABEL=${RUNTIME_ISO_LABEL}`,
    },
    yamlScalar,
  );
  // The digest also covers the meta-data template, so changing it re-runs cloud-init as well.
  const digest = createHash("sha256").update(userData).update("\0").update(templates.metaData).update("\0").update(hostname).digest("hex");
  const instanceId =
    previous === undefined
      ? `iid-${dotId}-${digest.slice(0, 16)}`
      : previous.digest === digest
        ? previous.instanceId
        : `iid-${dotId}-${digest.slice(0, 16)}-${createHash("sha256").update(previous.instanceId).digest("hex").slice(0, 8)}`;
  const metaData = renderTemplate(templates.metaData, { instanceId, hostname }, yamlScalar);
  return { userData, metaData, instanceId, digest };
}

/** Read the two cloud-init templates from a `virtualization/` directory. */
export async function loadSeedTemplates(virtualizationDir: string = DEFAULT_VIRTUALIZATION_DIR): Promise<SeedTemplates> {
  const read = (path: string) =>
    readFile(join(virtualizationDir, path), "utf8").catch((error: unknown) => {
      throw new Error(`cannot read template ${join(virtualizationDir, path)}: ${(error as Error).message}`, { cause: error });
    });
  const [userData, metaData] = await Promise.all([read("cloud-init/user-data.yaml.tmpl"), read("cloud-init/meta-data.yaml.tmpl")]);
  return { userData, metaData };
}

/** Write seed.iso (mode 0600: it carries the Dot's token). The file is replaced atomically. */
export async function writeSeedIso(path: string, seed: SeedFiles): Promise<void> {
  await writeIso(
    path,
    [
      { path: "user-data", data: seed.userData },
      { path: "meta-data", data: seed.metaData },
    ],
    { volumeId: SEED_VOLUME_ID, timestamp: SEED_TIMESTAMP, mode: 0o600 },
  );
}
