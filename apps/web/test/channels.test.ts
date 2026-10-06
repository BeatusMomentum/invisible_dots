import { CHANNEL_KINDS } from "@invisible-dots/shared/browser";
import { describe, expect, it } from "vitest";
import { CHANNEL_LABELS, viaChannel } from "../src/lib/channels";

describe("channel names", () => {
  it("has a name for every kind of channel the contract has", () => {
    expect(Object.keys(CHANNEL_LABELS).sort()).toEqual([...CHANNEL_KINDS].sort());
  });

  it("says where a message came from, and nothing for one that came through the web", () => {
    expect(viaChannel({ channel: "telegram", binding_id: "b", chat_id: "c", external_id: "e" })).toBe("via Telegram");
    expect(viaChannel({ channel: "whatsapp", binding_id: "b", chat_id: "c", external_id: "e" })).toBe("via WhatsApp");
    expect(viaChannel(undefined)).toBeUndefined();
  });
});
