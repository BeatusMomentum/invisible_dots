import { describe, expect, it } from "vitest";
import { readDraft, writeDraft } from "../src/lib/draft";

function memory() {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => void data.set(key, value),
    removeItem: (key: string) => void data.delete(key),
  };
}

describe("the draft of a message", () => {
  it("is kept per Dot and read back", () => {
    const storage = memory();
    writeDraft("d1", "half a thought", storage);
    writeDraft("d2", "another", storage);
    expect(readDraft("d1", storage)).toBe("half a thought");
    expect(readDraft("d2", storage)).toBe("another");
    expect(readDraft("d3", storage)).toBe("");
  });

  it("is removed, not stored empty, when the text is empty", () => {
    const storage = memory();
    writeDraft("d1", "text", storage);
    writeDraft("d1", "", storage);
    expect(storage.data.size).toBe(0);
  });

  it("is simply absent where storage is missing or refuses", () => {
    const refusing = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
      removeItem: () => {
        throw new Error("blocked");
      },
    };
    expect(readDraft("d1", refusing)).toBe("");
    expect(() => writeDraft("d1", "x", refusing)).not.toThrow();
    expect(readDraft("d1", null)).toBe("");
    expect(() => writeDraft("d1", "x", null)).not.toThrow();
  });
});
