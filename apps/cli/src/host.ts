/**
 * The real host commands: the doctor, setup, image build and server of
 * architecture section 11, wired to the real machine. Everything decided
 * here comes from the package that owns it: QEMU discovery and the
 * accelerator from the vm-manager, image verification and building from the
 * image builder, the control plane from the API, paths from shared. This
 * file only connects them; it holds no platform branch (those are in
 * setup/install.ts).
 *
 * cli.ts imports this module only when a host command runs, so the API
 * client commands never load QEMU discovery, the image builder or the
 * database.
 */
import { randomBytes } from "node:crypto";
import { mkdtemp, open, readFile, rm, stat, statfs } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { latestImage, parseListen, serverLogger, startServer, untilStopSignal } from "@invisible-dots/api";
import {
  buildGoldenImage,
  buildRuntimeIso,
  defaultRuntimeInputs,
  fetchVerified,
  verifyImage,
  type ProcessRunner,
} from "@invisible-dots/image-builder";
import { allowlistedEnvironment, currentUserSid, ENV, hostPaths, type HostPaths } from "@invisible-dots/shared";
import {
  accelerator,
  findQemu,
  firstLine,
  isExecutableFile,
  NodeCommandRunner,
  QEMU_SYSTEM_NAMES,
  QemuNotFoundError,
  qemuSearchDirs,
  runProcess,
  startProcess,
} from "@invisible-dots/vm-manager";
import windowsQemuPinJson from "../../../virtualization/qemu/windows.json" with { type: "json" };
import { connectApi } from "./api-client.js";
import { STORE_OPENROUTER_KEY } from "./commands.js";
import type { CliIo, HostCommands } from "./cli.js";
import type { CheckResult, DoctorDeps, FoundQemu } from "./doctor/checks.js";
import { doctorCommand } from "./doctor/command.js";
import { EXIT } from "./exit.js";
import { checkAcceleratorAccess, currentUserIsRoot, type InstallDeps } from "./setup/install.js";
import { parseWindowsQemuPin } from "./setup/qemu-pin.js";
import { serve } from "./serve.js";
import { runSetup } from "./setup/setup.js";
import { locateWebBuild, startWebServer } from "./web.js";

/**
 * The vm-manager's discovery, with each program reported separately for
 * doctor. findQemu stops at the first program it cannot find; the probe
 * passed as `exists` remembers qemu-system-x86_64 when it was found and only
 * qemu-img is missing, so doctor can still check its version.
 */
export async function locateQemu(env: Record<string, string | undefined>): Promise<FoundQemu> {
  const found = new Set<string>();
  const exists = async (path: string) => {
    const ok = await isExecutableFile(path);
    if (ok) found.add(path);
    return ok;
  };
  const configured = Boolean(env[ENV.QEMU_DIR]?.trim());
  try {
    const programs = await findQemu(env, exists);
    return { ...programs, searched: qemuSearchDirs(env), configured };
  } catch (error) {
    if (!(error instanceof QemuNotFoundError)) throw error;
    const system = [...found].find((path) => (QEMU_SYSTEM_NAMES as readonly string[]).includes(basename(path)));
    return { ...(system ? { system } : {}), searched: [...error.searched], configured };
  }
}

/** Free space where INVISIBLE_DOTS_HOME is or will be: its nearest existing directory, since doctor creates nothing. */
async function freeSpace(home: string): Promise<{ path: string; bytes: number }> {
  let path = home;
  for (;;) {
    const info = await stat(path).catch(() => undefined);
    if (info?.isDirectory()) break;
    const parent = dirname(path);
    if (parent === path) break;
    path = parent;
  }
  const fs = await statfs(path);
  return { path, bytes: fs.bavail * fs.bsize };
}

/** The image a Dot would get now (the newest one, as the control plane picks it), checked against its manifest. */
async function imageCheck(paths: HostPaths, id: "golden-image" | "runtime-image"): Promise<CheckResult> {
  const golden = id === "golden-image";
  const label = golden ? "golden image" : "runtime ISO";
  let image: string;
  try {
    image = await latestImage(paths.imagesDir, golden ? "golden" : "runtime");
  } catch {
    return { id, label, status: "missing", detail: `none in ${paths.imagesDir}`, fix: "invisible-dots image build" };
  }
  const verdict = await verifyImage(image);
  if (verdict.ok) return { id, label, status: "ok", detail: `${basename(image)} matches its manifest` };
  return { id, label, status: "failed", detail: verdict.reason, fix: verdict.fix };
}

/**
 * Whether the running server holds an OpenRouter key. The key lives in the
 * database, and the embedded PGlite database belongs to the one server
 * process that has it open (a second opener would corrupt it), so doctor
 * asks the server instead of reading the database.
 */
async function openRouterKey(env: Record<string, string | undefined>, fetchImpl?: typeof fetch): Promise<CheckResult> {
  const base = { id: "openrouter", label: "OpenRouter key" } as const;
  let health: unknown;
  try {
    health = await (await connectApi(env, fetchImpl)).health();
  } catch (error) {
    return {
      ...base,
      status: "failed",
      detail: `cannot tell while the server is not reachable (${firstLine((error as Error).message)})`,
      fix: "start it with: invisible-dots server, then run invisible-dots doctor again",
    };
  }
  const configured = (health as { openrouter_configured?: unknown }).openrouter_configured;
  if (configured === true) return { ...base, status: "ok", detail: "stored" };
  if (configured === false) {
    return { ...base, status: "missing", detail: "no key stored", fix: STORE_OPENROUTER_KEY };
  }
  return { ...base, status: "failed", detail: "the server's /api/health does not report openrouter_configured", fix: "update the server" };
}

function doctorDeps(io: CliIo): DoctorDeps {
  const paths = hostPaths(io.env);
  return {
    nodeVersion: process.versions.node,
    // Asked when a check needs it: on an unsupported host it throws, and that check reports it.
    accelerator: () => accelerator(),
    findQemu: () => locateQemu(io.env),
    run: runProcess,
    acceleratorAccess: () => checkAcceleratorAccess(installDeps(io)),
    home: paths.home,
    freeSpace: () => freeSpace(paths.home),
    images: async () => [await imageCheck(paths, "golden-image"), await imageCheck(paths, "runtime-image")],
    webBuild: () => locateWebBuild(REPO_ROOT),
    openRouterKey: () => openRouterKey(io.env, io.fetch),
  };
}

function installDeps(io: CliIo): InstallDeps {
  const log = (line: string) => io.stdout(`${line}\n`);
  return {
    platform: process.platform,
    env: io.env,
    run: runProcess,
    openReadWrite: async (path) => {
      await (await open(path, "r+")).close();
    },
    log,
    readText: (path) => readFile(path, "utf8"),
    isRoot: currentUserIsRoot(),
    windowsQemuPin: () => parseWindowsQemuPin(windowsQemuPinJson),
    userSid: () => currentUserSid(io.env),
    uniqueName: () => randomBytes(16).toString("hex"),
    makeTempDir: () => mkdtemp(join(tmpdir(), "invisible-dots-setup-")),
    removeDir: (path) => rm(path, { recursive: true, force: true }),
    download: async (pin, dest) => {
      await fetchVerified({ url: pin.url, sha256: pin.sha256 }, dest, { log, ...(io.fetch ? { fetch: io.fetch } : {}) });
    },
  };
}

/** The image builder's process boundary: the host's one runner, the same one the vm-manager uses for qemu-img. */
const commands = new NodeCommandRunner();
const processRunner: ProcessRunner = {
  run: (command, args, options) => commands.run(command, args, options),
  spawn: (command, args, options) => startProcess(command, args, { cwd: options.cwd, env: allowlistedEnvironment(process.env) }),
};

/**
 * The repository root. apps/cli/src/host.ts and the bundle
 * apps/cli/dist/invisible-dots.mjs sit at the same depth, so this holds for
 * both. The image builder's own default would point inside apps/cli once
 * bundled, so its guest files are named here (the engine's source is named by
 * defaultRuntimeInputs, from this same root).
 */
const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const IMAGE_BUILDER_DIR = join(REPO_ROOT, "guest", "image-builder");

/**
 * The runtime ISO first: it takes seconds and fails at once when the agent
 * bundle or dot-agentd has not been built, before an hour of golden image
 * provisioning.
 */
async function imageBuild(io: CliIo): Promise<number> {
  const log = (line: string) => io.stdout(`${line}\n`);
  const paths = hostPaths(io.env);
  const runtime = await buildRuntimeIso({ paths, log, assetRoot: IMAGE_BUILDER_DIR, inputs: defaultRuntimeInputs(REPO_ROOT) });
  log(`${runtime.created ? "built" : "already built"}: ${runtime.iso}`);
  const qemu = await findQemu(io.env);
  const golden = await buildGoldenImage({
    qemu,
    accelerator: accelerator(),
    runner: processRunner,
    paths,
    assetRoot: IMAGE_BUILDER_DIR,
    log,
    ...(io.fetch ? { fetch: io.fetch } : {}),
    ...(io.signal ? { signal: io.signal } : {}),
  });
  log(`${golden.created ? "built" : "already built"}: ${golden.image}`);
  return EXIT.ok;
}

export function realHostCommands(): HostCommands {
  return {
    doctor: (options, io) => doctorCommand(doctorDeps(io), options, io.stdout),
    setup: (io) => runSetup({ doctor: doctorDeps(io), install: installDeps(io), out: io.stdout }),
    imageBuild,
    server: async (io, options) => {
      await serve(
        { env: io.env, logger: serverLogger(io.env), web: options.web, repoRoot: REPO_ROOT },
        { startServer, untilStopSignal, parseListen, startWebServer },
      );
      return EXIT.ok;
    },
  };
}
