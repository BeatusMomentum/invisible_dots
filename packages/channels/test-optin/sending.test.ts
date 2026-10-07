/**
 * What Baileys does with the text the glue hands it, against the real library. Needs the opt-in client installed
 * (`npm run whatsapp:install`): this suite is `npm run test:whatsapp`.
 */
import { describe, expect, it } from "vitest";
import { textContent } from "../src/whatsapp-baileys/baileys.js";
import { baileys, type Baileys } from "./client.js";

describe("what is sent", () => {
  /** Baileys' own content builder, with a `getUrlInfo` that records the links it was asked to preview (the real one fetches them, from this machine). */
  async function previewed(content: { text: string; linkPreview?: null }): Promise<string[]> {
    const lib: Baileys = await baileys;
    const fetched: string[] = [];
    const getUrlInfo = async (url: string) => {
      fetched.push(url);
      return undefined;
    };
    await lib.generateWAMessageContent(content, { getUrlInfo, upload: async () => ({}) as never } as never);
    return fetched;
  }

  it("never has Baileys fetch a link of a text: an approval prompt or a Dot's message is not requested from here", async () => {
    const text = "The Dot asks to open https://example.com/search?q=the+secret";
    expect(await previewed(textContent(text))).toEqual([]);
    // Without the setting, the same text is fetched by the library: the check above can fail.
    expect(await previewed({ text })).toEqual(["https://example.com/search?q=the+secret"]);
  });
});
