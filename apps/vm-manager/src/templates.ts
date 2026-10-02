/**
 * Rendering of the files under `virtualization/`: the libvirt domain and the
 * cloud-init NoCloud seed. The templates on disk are the single source of
 * their content; this module only fills them in, escaping every value for the
 * language of the file it lands in.
 */
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { LIBVIRT_NETWORK, domainName, type GuestBootConfig } from "@invisible-dots/shared";

/** `virtualization/` of this repository, found relative to this file. */
export const DEFAULT_VIRTUALIZATION_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../../../virtualization");

/** Volume label of the runtime ISO; build-runtime.sh writes it, the seed mounts by it. */
export const RUNTIME_ISO_LABEL = "IDOTS-RT";

/** Code points XML 1.0 cannot carry: C0 controls other than tab, LF, CR, and U+FFFE / U+FFFF. */
function hasXmlForbiddenChar(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const c = value.charCodeAt(i);
    if ((c < 0x20 && c !== 0x09 && c !== 0x0a && c !== 0x0d) || c === 0xfffe || c === 0xffff) return true;
  }
  return false;
}

export function escapeXml(value: string): string {
  // Characters XML 1.0 cannot carry at all are refused rather than silently dropped.
  if (hasXmlForbiddenChar(value)) {
    throw new Error(`value ${JSON.stringify(value)} contains a control character that XML cannot represent`);
  }
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/**
 * A YAML double-quoted scalar. JSON string syntax is a subset of YAML's
 * double-quoted style, so JSON.stringify is a correct encoder here.
 */
export function yamlScalar(value: string): string {
  return JSON.stringify(value);
}

/**
 * Replace each `{{name}}` with `encode(values[name])`. A placeholder without a
 * value is an error: an empty source path in a domain is a broken VM that
 * libvirt would accept.
 */
export function renderTemplate(
  template: string,
  values: Record<string, string | number>,
  encode: (value: string) => string,
): string {
  return template.replace(/\{\{\s*([A-Za-z][A-Za-z0-9_]*)\s*\}\}/g, (_match, name: string) => {
    const value = values[name];
    if (value === undefined) throw new Error(`template placeholder "${name}" has no value`);
    return encode(String(value));
  });
}

export interface DomainParams {
  dotId: string;
  cid: number;
  cpus: number;
  memoryMiB: number;
  diskPath: string;
  seedPath: string;
  runtimeImage: string;
  serialLog: string;
  network?: string;
}

export function renderDomainXml(template: string, params: DomainParams): string {
  return renderTemplate(
    template,
    {
      name: domainName(params.dotId),
      dotId: params.dotId,
      cid: params.cid,
      cpus: params.cpus,
      memoryMiB: params.memoryMiB,
      diskPath: params.diskPath,
      seedPath: params.seedPath,
      runtimeImage: params.runtimeImage,
      serialLog: params.serialLog,
      network: params.network ?? LIBVIRT_NETWORK,
    },
    escapeXml,
  );
}

/**
 * The guest hostname. Dot ids contain `_`, which is not valid in a hostname,
 * so it becomes `-`.
 */
export function guestHostname(dotId: string): string {
  return `invisible-dot-${dotId.replace(/_/g, "-")}`;
}

export interface SeedFiles {
  userData: string;
  metaData: string;
}

export function renderSeed(templates: SeedFiles, dotId: string, token: string): SeedFiles {
  const bootConfig: GuestBootConfig = { dotId, token };
  const values = {
    hostname: guestHostname(dotId),
    instanceId: `iid-${dotId}`,
    bootConfigJson: `${JSON.stringify(bootConfig)}\n`,
    runtimeDevice: `LABEL=${RUNTIME_ISO_LABEL}`,
  };
  return {
    userData: renderTemplate(templates.userData, values, yamlScalar),
    metaData: renderTemplate(templates.metaData, values, yamlScalar),
  };
}

export interface TemplateSet {
  domain: string;
  seed: SeedFiles;
}

/** Read the three templates from a `virtualization/` directory. */
export async function loadTemplates(virtualizationDir: string = DEFAULT_VIRTUALIZATION_DIR): Promise<TemplateSet> {
  const read = (path: string) =>
    readFile(join(virtualizationDir, path), "utf8").catch((error: unknown) => {
      throw new Error(`cannot read template ${join(virtualizationDir, path)}: ${(error as Error).message}`, { cause: error });
    });
  const [domain, userData, metaData] = await Promise.all([
    read("libvirt/domain.xml.tmpl"),
    read("cloud-init/user-data.yaml.tmpl"),
    read("cloud-init/meta-data.yaml.tmpl"),
  ]);
  return { domain, seed: { userData, metaData } };
}
