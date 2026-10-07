// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DotShell } from "../src/components/DotShell";
import { DotEventScope, EventStreamProvider } from "../src/components/events";
import { AttentionProvider } from "../src/components/shell/attention";
import { SkillsView } from "../src/components/skills/SkillsView";
import { parseSkillsQuery, skillBody, skillsHref } from "../src/lib/skills-view";
import { stubMatchMedia } from "./support/browser";
import { dotRecord, FakeControlPlane } from "./support/control-plane";

vi.mock("next/navigation", () => ({ usePathname: () => "/dots/d1/skills", useRouter: () => ({ push() {}, replace() {} }) }));

let plane: FakeControlPlane;

beforeEach(() => {
  plane = new FakeControlPlane();
  plane.dots = [dotRecord("d1", { name: "fares" })];
  plane.install();
  stubMatchMedia();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const own = {
  name: "shop-login",
  description: "Log in to the shop.",
  source: "dot" as const,
  path: "/home/dot/skills/shop-login/SKILL.md",
  content: "---\nname: shop-login\ndescription: Log in to the shop.\n---\n\nClick **Sign in**, then type the email.\n",
};

async function renderSkills(params: Record<string, string> = {}) {
  render(
    <EventStreamProvider>
      <AttentionProvider>
        <DotEventScope dotId="d1">
          <DotShell dotId="d1">
            <SkillsView query={parseSkillsQuery(params)} />
          </DotShell>
        </DotEventScope>
      </AttentionProvider>
    </EventStreamProvider>,
  );
  await screen.findByRole("heading", { level: 1, hidden: true });
  await waitFor(() => expect(plane.streamOpen).toBe(true));
}

describe("the address of the Skills page", () => {
  it("holds the open skill, and the shortest address for none", () => {
    expect(parseSkillsQuery({})).toEqual({ skill: null });
    expect(parseSkillsQuery({ skill: ["shop-login", "x"] })).toEqual({ skill: "shop-login" });
    expect(skillsHref("my dot")).toBe("/dots/my%20dot/skills");
    expect(skillsHref("d1", "shop-login")).toBe("/dots/d1/skills?skill=shop-login");
  });

  it("shows a skill's file without its frontmatter", () => {
    expect(skillBody(own.content)).toBe("Click **Sign in**, then type the email.\n");
    expect(skillBody("no frontmatter\n")).toBe("no frontmatter\n");
  });
});

describe("the Skills page", () => {
  it("lists the built-in skills and the Dot's own, saying which is which, and asks to pick one", async () => {
    plane.skills = [...plane.skills!, own];
    await renderSkills();
    const list = await screen.findByRole("list", { name: "The Dot's skills" });
    const rows = within(list).getAllByRole("link");
    expect(rows.map((row) => row.getAttribute("href"))).toEqual(["/dots/d1/skills?skill=invisible-playwright", "/dots/d1/skills?skill=shop-login"]);
    expect(rows[0]!.textContent).toContain("Built in");
    expect(rows[1]!.textContent).toContain("Written by the Dot");
    expect(rows[1]!.textContent).toContain("Log in to the shop.");
    expect(screen.getByText("Pick a skill to read it.")).toBeTruthy();
  });

  it("shows the open skill as Markdown, with where it is on the computer, and says so of a name it does not have", async () => {
    plane.skills = [...plane.skills!, own];
    await renderSkills({ skill: "shop-login" });
    const open = await screen.findByRole("region", { name: "The skill shop-login" });
    expect(within(open).getByText("/home/dot/skills/shop-login/SKILL.md")).toBeTruthy();
    expect(within(open).getByText("Sign in").tagName).toBe("STRONG");
    expect(open.textContent).not.toContain("description:");
    expect(within(screen.getByRole("list", { name: "The Dot's skills" })).getByRole("link", { current: "page" }).textContent).toContain("shop-login");
    cleanup();

    await renderSkills({ skill: "gone" });
    expect(await screen.findByText("The Dot has no skill named gone.")).toBeTruthy();
  });

  it("reads the list again when a turn ends, which may have written a skill", async () => {
    await renderSkills();
    await screen.findByRole("list", { name: "The Dot's skills" });
    plane.skills = [...plane.skills!, own];
    act(() => plane.push("d1", "message.assistant", { text: "I wrote down how to log in." }));
    expect(await screen.findByText("shop-login")).toBeTruthy();
  });

  it("asks nothing of a stopped computer and offers to start it", async () => {
    plane.dots = [dotRecord("d1", { name: "fares", computer_state: "STOPPED" })];
    await renderSkills();
    expect((await screen.findByRole("status")).textContent).toContain("Start the computer to see its skills");
    expect(plane.requests.filter((r) => /\/skills$/.test(r))).toEqual([]);
  });
});
