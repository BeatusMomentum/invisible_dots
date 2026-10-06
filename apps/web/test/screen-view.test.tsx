// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { ScreenView } from "../src/components/computer/screen-view";
import { contrast, fromHex } from "./support/contrast";
import { themes } from "./support/tokens";

afterEach(cleanup);

/** The tokens a badge is painted with: its `bg-<token>` and `text-<token>` classes, which must be color tokens of both themes. */
function badgeTokens(badge: HTMLElement): { background: string; text: string } {
  const classes = [...badge.classList];
  const named = (prefix: string) => classes.find((c) => c.startsWith(prefix) && c.slice(prefix.length) in themes.light);
  const background = named("bg-");
  const text = named("text-");
  if (!background || !text) throw new Error(`the badge is not painted with tokens: ${badge.className}`);
  return { background: background.slice(3), text: text.slice(5) };
}

describe("the badges over the screen", () => {
  const badges: [string, () => HTMLElement][] = [
    ["LIVE", () => screen.getByText("LIVE")],
    ["the stale warning", () => screen.getByRole("status")],
  ];

  it.each(badges)("%s is painted with two tokens that read at AA (4.5:1) in the light and the dark theme", (name, find) => {
    const now = Date.parse("2026-01-01T00:00:10Z");
    render(<ScreenView alt="the desktop" live={name === "LIVE"} lastFrameAt="2026-01-01T00:00:00Z" staleAfterSeconds={name === "LIVE" ? 60 : 5} now={now} />);
    const { background, text } = badgeTokens(find());
    for (const theme of Object.values(themes)) expect(contrast(fromHex(theme[text]!), fromHex(theme[background]!))).toBeGreaterThanOrEqual(4.5);
  });
});
