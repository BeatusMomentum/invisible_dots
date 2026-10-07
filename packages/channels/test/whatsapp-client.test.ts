/**
 * The WhatsApp client is an opt-in install (it depends on libsignal, GPL-3.0): the adapter loads it from its own
 * folder only when it is there, and otherwise says how to enable it. The library itself is not needed here: a folder
 * that holds a stand-in module of the same name is enough to prove what the loader does. The real library is in
 * test-optin/, run by `npm run test:whatsapp`.
 */
import type { ChannelBindingRecord } from "@invisible-dots/database";
import { ENV } from "@invisible-dots/shared";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { WHATSAPP_INSTALL_COMMAND, WhatsAppChannelType, WhatsAppClientMissingError, WhatsAppClientVersionError, loadWhatsAppClient, whatsappClientDir, whatsappClientProblem } from "../src/index.js";
import { BaileysConnector } from "../src/whatsapp-baileys/baileys.js";
import type { WhatsAppEvents } from "../src/whatsapp-baileys/port.js";

const folders: string[] = [];
afterEach(async () => {
  for (const folder of folders.splice(0)) await rm(folder, { recursive: true, force: true });
});
const emptyFolder = async () => {
  const folder = await mkdtemp(join(tmpdir(), "idots-wa-client-"));
  folders.push(folder);
  return folder;
};

/** What `npm run whatsapp:install` leaves in the client folder, with a stand-in for the library: a package called baileys. `pinned` is the version the folder's package.json declares, `installed` the one in node_modules. */
async function install(folder: string, { pinned = "0.0.0-stand-in", installed = "0.0.0-stand-in" }: { pinned?: string | null; installed?: string } = {}): Promise<void> {
  await writeFile(join(folder, "package.json"), JSON.stringify({ name: "stand-in", private: true, type: "module", dependencies: pinned === null ? {} : { baileys: pinned } }));
  const lib = join(folder, "node_modules", "baileys");
  await mkdir(lib, { recursive: true });
  await writeFile(join(lib, "package.json"), JSON.stringify({ name: "baileys", version: installed, type: "module", main: "index.js" }));
  await writeFile(join(lib, "index.js"), "export const marker = 'stand-in';\nexport function initAuthCreds() { return { fresh: true }; }\n");
}

describe("the opt-in WhatsApp client", () => {
  it("is looked for under optional/whatsapp of the repository", () => {
    expect(whatsappClientDir("/repo")).toBe(join("/repo", "optional", "whatsapp"));
  });

  it("is not installed in an empty folder, and loading it fails with the one command that installs it and the variable that turns WhatsApp on", async () => {
    const folder = await emptyFolder();
    expect(whatsappClientProblem(folder)).toBeInstanceOf(WhatsAppClientMissingError);
    const error = await loadWhatsAppClient(folder).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(WhatsAppClientMissingError);
    const message = (error as Error).message;
    expect(WHATSAPP_INSTALL_COMMAND).toBe("npm run whatsapp:install");
    expect(message).toContain("`npm run whatsapp:install`");
    expect(message).toContain(`${ENV.WHATSAPP}=1`);
    expect(message).toContain("GPL-3.0");
  });

  it("is loaded from the folder it is installed in, by path, and a folder that gets it after a failed try finds it the next time", async () => {
    const folder = await emptyFolder();
    await expect(loadWhatsAppClient(folder)).rejects.toBeInstanceOf(WhatsAppClientMissingError);
    await install(folder);
    expect(whatsappClientProblem(folder)).toBeNull();
    const lib = (await loadWhatsAppClient(folder)) as unknown as { marker: string; initAuthCreds(): unknown };
    expect(lib.marker).toBe("stand-in");
    expect(lib.initAuthCreds()).toEqual({ fresh: true });
  });

  it("is not found in a parent folder: only the folder it was installed into counts", async () => {
    const parent = await emptyFolder();
    await install(parent);
    const child = join(parent, "inner");
    await mkdir(child);
    expect(whatsappClientProblem(child)).toBeInstanceOf(WhatsAppClientMissingError);
    await expect(loadWhatsAppClient(child)).rejects.toBeInstanceOf(WhatsAppClientMissingError);
  });

  it("is not loaded when the installed release is not the pinned one: a pull that moved the pin leaves the old release in node_modules, and nothing runs until the install is made again", async () => {
    const folder = await emptyFolder();
    await install(folder, { pinned: "7.0.0-rc15", installed: "7.0.0-rc14" });
    const problem = whatsappClientProblem(folder);
    expect(problem).toBeInstanceOf(WhatsAppClientVersionError);
    expect(problem).toMatchObject({ pinned: "7.0.0-rc15", installed: "7.0.0-rc14" });
    const error = await loadWhatsAppClient(folder).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(WhatsAppClientVersionError);
    const message = (error as Error).message;
    expect(message).toContain("7.0.0-rc14");
    expect(message).toContain("7.0.0-rc15");
    expect(message).toContain("`npm run whatsapp:install`");
    expect(message).toContain(`${ENV.WHATSAPP}=1`);
    // The install is made again, and the same folder loads.
    await install(folder, { pinned: "7.0.0-rc15", installed: "7.0.0-rc15" });
    expect(whatsappClientProblem(folder)).toBeNull();
    await expect(loadWhatsAppClient(folder)).resolves.toBeDefined();
  });

  it("is not loaded when the folder pins no release, or the installed package says no version: what cannot be compared is not trusted", async () => {
    const folder = await emptyFolder();
    await install(folder, { pinned: null });
    expect(whatsappClientProblem(folder)).toMatchObject({ name: "WhatsAppClientVersionError", pinned: null, installed: "0.0.0-stand-in" });
    await expect(loadWhatsAppClient(folder)).rejects.toBeInstanceOf(WhatsAppClientVersionError);
    await install(folder);
    await writeFile(join(folder, "node_modules", "baileys", "package.json"), JSON.stringify({ name: "baileys", type: "module", main: "index.js" }));
    expect(whatsappClientProblem(folder)).toMatchObject({ name: "WhatsAppClientVersionError", pinned: "0.0.0-stand-in", installed: null });
  });

  it("makes a connector that fails to connect with those words, before it reads or writes a single secret", async () => {
    const folder = await emptyFolder();
    const touched: string[] = [];
    const secrets = {
      get: async (_scope: string, name: string) => (touched.push(name), null),
      putAll: async (_scope: string, entries: Readonly<Record<string, string>>) => void touched.push(...Object.keys(entries)),
    };
    const events: WhatsAppEvents = { code: () => {}, open: () => {}, message: () => {}, end: () => {} };
    await expect(new BaileysConnector("dot_1", secrets, { clientDir: folder }).connect(events)).rejects.toThrow(/npm run whatsapp:install/);
    expect(touched).toEqual([]);
  });

  it("makes a channel whose run says the same, so the status of a Dot's WhatsApp channel names the command", async () => {
    const folder = await emptyFolder();
    const binding = { id: "chb_1", dot_id: "dot_1", kind: "whatsapp", enabled: true, settings: {}, status: "connecting", status_detail: null, account: null, event_cursor: 0, created_at: "now" } as ChannelBindingRecord;
    const channel = await new WhatsAppChannelType({ baileys: { clientDir: folder } }).create(binding, { get: async () => null, putAll: async () => {} });
    const sink = { inbound: async () => {}, pairing: async () => false, approval: async () => "", status: () => {}, linkCode: () => {} };
    await expect(channel.run(sink, new AbortController().signal)).rejects.toThrow(/npm run whatsapp:install/);
  });
});
