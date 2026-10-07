/**
 * The invisible-dots command ships as one esbuild bundle, and some code works from source and fails once bundled: the
 * Telegram adapter did, every call ("Network request for 'getMe' failed!") because the bundle renamed AbortSignal and
 * node-fetch, under grammY, checks a signal by its constructor's name. Here a real grammY call is bundled with the
 * command's own options (apps/cli/scripts/bundle-options.mjs) and run with plain node against the fake Bot API.
 */
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { FakeBotApi } from "@invisible-dots/channels/testing";
import { build } from "esbuild";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BUNDLE_OPTIONS } from "../../apps/cli/scripts/bundle-options.mjs";

const repo = resolve(fileURLToPath(new URL(".", import.meta.url)), "../..");
const run = promisify(execFile);

describe("the command's bundle", () => {
  let bots: FakeBotApi;
  let dir: string;

  beforeAll(async () => {
    bots = await FakeBotApi.start();
    bots.addBot("123456:known-token", "bundle_bot");
    dir = await mkdtemp(join(tmpdir(), "cli-bundle-"));
  });

  afterAll(async () => {
    await bots?.close();
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it("reaches Telegram through grammY as the source does: a known token is the bot, a wrong one is Telegram's 401", async () => {
    const entry = join(dir, "entry.mjs");
    await writeFile(
      entry,
      [
        'import { Api, GrammyError } from "grammy";',
        "const [, , apiRoot, ...tokens] = process.argv;",
        "for (const token of tokens) {",
        "  try {",
        "    const me = await new Api(token, { apiRoot }).getMe(AbortSignal.timeout(10_000));",
        "    console.log(`ok ${me.username}`);",
        "  } catch (error) {",
        "    console.log(error instanceof GrammyError ? `telegram ${error.error_code}` : `failed ${error.message}`);",
        "  }",
        "}",
      ].join("\n"),
    );
    const outfile = join(dir, "entry.bundle.mjs");
    await build({ ...BUNDLE_OPTIONS, sourcemap: false, entryPoints: [entry], outfile, logLevel: "silent", nodePaths: [join(repo, "packages/channels/node_modules"), join(repo, "node_modules")] });

    const { stdout } = await run(process.execPath, [outfile, bots.apiRoot, "123456:known-token", "123456:wrong-token"], { timeout: 30_000 });

    expect(stdout.trim().split(/\r?\n/)).toEqual(["ok bundle_bot", "telegram 401"]);
  });
});
