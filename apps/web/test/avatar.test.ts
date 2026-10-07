import { contrast, fromHsl } from "./support/contrast";
import { describe, expect, it } from "vitest";
import { avatarOf, hash32 } from "../src/lib/avatar";

describe("the Dot avatar", () => {
  it("is the same for the same id on every call, and different ids get different faces", () => {
    expect(avatarOf("dot_abc", "research")).toEqual(avatarOf("dot_abc", "research"));
    const faces = new Set(["dot_a", "dot_b", "dot_c", "dot_d", "dot_e", "dot_f"].map((id) => avatarOf(id, "x").background));
    expect(faces.size).toBe(6);
  });

  it("is a gradient between two hues, from a stable hash", () => {
    expect(hash32("")).toBe(0x811c9dc5);
    // The FNV-1a test vector for "a".
    expect(hash32("a")).toBe(0xe40c292c);
    expect(avatarOf("dot_abc", "research").background).toMatch(/^linear-gradient\(135deg, hsl\(\d+ 60% 28%\), hsl\(\d+ 60% 22%\)\)$/);
  });

  it("shows the first letter of the name in capitals, a question mark for a blank name, and whole characters", () => {
    expect(avatarOf("a", "research").initial).toBe("R");
    expect(avatarOf("a", "  mailer").initial).toBe("M");
    expect(avatarOf("a", "").initial).toBe("?");
    expect(avatarOf("a", "   ").initial).toBe("?");
    // A character outside the BMP is one character, not half a surrogate pair.
    expect(avatarOf("a", "\u{1F600}x").initial).toBe("\u{1F600}");
  });
});

describe("the initial on the face", () => {
  /** Every `hsl(h s% l%)` of the gradient: the two colors the white letter can sit on (anything between is no lighter than the lighter end). */
  function ends(background: string): Array<[number, number, number]> {
    return [...background.matchAll(/hsl\((\d+) (\d+)% (\d+)%\)/g)].map((m) => [Number(m[1]), Number(m[2]) / 100, Number(m[3]) / 100]);
  }

  it("is white on every hue the hash can pick, and reads at AA (4.5 to 1), the yellow and green hues included", () => {
    const hues = new Set<number>();
    let worst = Infinity;
    for (let i = 0; i < 20000; i++) {
      for (const [hue, saturation, lightness] of ends(avatarOf(`dot_${i}`, "x").background)) {
        hues.add(hue);
        worst = Math.min(worst, contrast([255, 255, 255], fromHsl(hue, saturation, lightness)));
      }
    }
    // The sample reaches every hue, so the worst of it is the worst the hash can give.
    expect(hues.size).toBe(360);
    expect(worst).toBeGreaterThanOrEqual(4.5);
  });
});
