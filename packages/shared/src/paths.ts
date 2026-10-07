/**
 * The host filesystem of architecture section 3.2. Every host uses the same
 * layout under one root, INVISIBLE_DOTS_HOME, so this is the only place that
 * knows a host path; Node-only (the web client must not import this file).
 */
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { ENV } from "./protocol.js";

/** Dot ids and image versions become directory and file names: keep them to one plain path segment. */
const SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function segment(value: string, what: string): string {
  if (!SEGMENT.test(value)) {
    throw new Error(`invalid ${what} "${value}": expected letters, digits, ".", "_" or "-", starting with a letter or digit`);
  }
  return value;
}

/**
 * The two built images of section 3.3 and how their files are named in
 * `images/`. The image builder writes these names, the control plane and
 * doctor pick the newest by them, so this is the one place that knows them.
 */
export type ImageKind = "golden" | "runtime";

const IMAGE_FILES: Record<ImageKind, { prefix: string; extension: string; label: string }> = {
  golden: { prefix: "golden-", extension: ".qcow2", label: "golden image" },
  runtime: { prefix: "runtime-", extension: ".iso", label: "runtime ISO" },
};

/** `golden-<version>.qcow2` or `runtime-<version>.iso`. */
export function imageFileName(kind: ImageKind, version: string): string {
  const { prefix, extension } = IMAGE_FILES[kind];
  return `${prefix}${segment(version, "image version")}${extension}`;
}

/** The version in an image file name of that kind, or undefined for any other file. */
export function imageVersionOf(kind: ImageKind, fileName: string): string | undefined {
  const { prefix, extension } = IMAGE_FILES[kind];
  if (!fileName.startsWith(prefix) || !fileName.endsWith(extension)) return undefined;
  const version = fileName.slice(prefix.length, fileName.length - extension.length);
  return SEGMENT.test(version) ? version : undefined;
}

/** How messages name an image of that kind. */
export function imageLabel(kind: ImageKind): string {
  return IMAGE_FILES[kind].label;
}

export interface HostPaths {
  /** INVISIBLE_DOTS_HOME, absolute. */
  home: string;
  configDir: string;
  /** 32 random bytes that encrypt the secrets in the database. */
  masterKeyPath: string;
  /** The API bearer token. */
  apiTokenPath: string;
  /** The PGlite data directory. */
  dbDir: string;
  /**
   * Holds the pid of the one server running on this home: PGlite does not
   * lock its data directory, and two servers would also drive the same QEMU
   * processes.
   */
  serverLockPath: string;
  imagesDir: string;
  /** The downloaded base cloud image, named by `local_name` in virtualization/images/base.json. */
  baseImagePath(fileName: string): string;
  goldenImagePath(version: string): string;
  runtimeIsoPath(version: string): string;
  vmsDir: string;
  vmDir(dotId: string): string;
  /** The qcow2 overlay whose backing file is a golden image. */
  diskPath(dotId: string): string;
  /** The NoCloud seed image. */
  seedPath(dotId: string): string;
  /**
   * The pid file of the running VM: QEMU's pid and the guest port it
   * forwards, as JSON. The vm-manager writes it when it spawns QEMU, so it is
   * the one record of which process and which port belong to this Dot.
   */
  processFilePath(dotId: string): string;
  /** The guest serial console. */
  serialLogPath(dotId: string): string;
  logsDir: string;
  /** QEMU's own output for one Dot; outside the VM directory, next to the other logs. */
  qemuLogPath(dotId: string): string;
}

/**
 * Every host path, from INVISIBLE_DOTS_HOME (default `~/.invisible-dots`).
 * A relative INVISIBLE_DOTS_HOME is made absolute against the current
 * directory now, because QEMU runs detached and is always given absolute
 * paths.
 */
export function hostPaths(env: Record<string, string | undefined> = process.env, userHome: string = homedir()): HostPaths {
  const configured = env[ENV.HOME]?.trim();
  const home = resolve(configured ? configured : join(userHome, ".invisible-dots"));
  const configDir = join(home, "config");
  const imagesDir = join(home, "images");
  const vmsDir = join(home, "vms");
  const vmDir = (dotId: string) => join(vmsDir, segment(dotId, "dot id"));

  return {
    home,
    configDir,
    masterKeyPath: join(configDir, "master.key"),
    apiTokenPath: join(configDir, "api.token"),
    dbDir: join(home, "db"),
    serverLockPath: join(home, "server.lock"),
    imagesDir,
    baseImagePath: (fileName) => join(imagesDir, segment(fileName, "image file name")),
    goldenImagePath: (version) => join(imagesDir, imageFileName("golden", version)),
    runtimeIsoPath: (version) => join(imagesDir, imageFileName("runtime", version)),
    vmsDir,
    vmDir,
    diskPath: (dotId) => join(vmDir(dotId), "disk.qcow2"),
    seedPath: (dotId) => join(vmDir(dotId), "seed.iso"),
    processFilePath: (dotId) => join(vmDir(dotId), "qemu.json"),
    serialLogPath: (dotId) => join(vmDir(dotId), "serial.log"),
    logsDir: join(home, "logs"),
    qemuLogPath: (dotId) => join(home, "logs", `qemu-${segment(dotId, "dot id")}.log`),
  };
}
