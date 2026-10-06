// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Markdown } from "../src/components/markdown";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("Markdown", () => {
  it("renders what a Dot wrote: emphasis, lists, code and tables", () => {
    const { container } = render(<Markdown>{"**bold** and `code`\n\n- one\n- two\n\n| a | b |\n|---|---|\n| 1 | 2 |"}</Markdown>);
    expect(container.querySelector("strong")?.textContent).toBe("bold");
    expect(container.querySelector("code")?.textContent).toBe("code");
    expect(container.querySelectorAll("li")).toHaveLength(2);
    expect(container.querySelectorAll("td")).toHaveLength(2);
  });

  it("opens links in a new tab without telling the target where the person came from", () => {
    const { container } = render(<Markdown>{"[the docs](https://example.com/docs)"}</Markdown>);
    const link = container.querySelector("a")!;
    expect(link.getAttribute("href")).toBe("https://example.com/docs");
    expect(link.getAttribute("target")).toBe("_blank");
    expect(link.getAttribute("rel")).toBe("noreferrer");
  });

  it("never renders HTML the text carries", () => {
    const { container } = render(<Markdown>{'before <img src="x" onerror="alert(1)"> <script>alert(2)</script> <b>raw</b> after'}</Markdown>);
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("script")).toBeNull();
    expect(container.querySelector("b")).toBeNull();
    expect(container.textContent).toContain("before");
    expect(container.textContent).toContain("after");
  });

  it("does not turn a javascript: link into a link", () => {
    const { container } = render(<Markdown>{"[click](javascript:alert(1))"}</Markdown>);
    expect(container.querySelector("a")?.getAttribute("href") ?? "").not.toMatch(/^javascript:/i);
  });

  it("shows an image as a link to it, so that reading the message asks nobody for the picture", () => {
    const { container } = render(<Markdown>{"before ![a chart](https://tracker.example/pixel.png?q=secret) after"}</Markdown>);
    expect(container.querySelector("img")).toBeNull();
    const link = container.querySelector("a")!;
    expect(link.getAttribute("href")).toBe("https://tracker.example/pixel.png?q=secret");
    expect(link.textContent).toBe("Image: a chart");
    expect(link.getAttribute("rel")).toBe("noreferrer");
  });

  it("puts a copy button on a fenced block, which copies its code and says so", async () => {
    const writeText = vi.fn(async (_text: string) => {});
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    const { container } = render(<Markdown>{"Run:\n\n```sh\nls -la\necho done\n```\n\nand `inline` code"}</Markdown>);
    expect(container.querySelectorAll("pre")).toHaveLength(1);
    expect(screen.getAllByRole("button", { name: "Copy the code" })).toHaveLength(1);
    await userEvent.click(screen.getByRole("button", { name: "Copy the code" }));
    expect(writeText).toHaveBeenCalledWith("ls -la\necho done");
    expect(await screen.findByRole("button", { name: "Copied" })).toBeTruthy();
  });

  it("keeps the code readable when the clipboard refuses", async () => {
    vi.stubGlobal("navigator", { clipboard: { writeText: vi.fn(async () => Promise.reject(new Error("denied"))) } });
    const { container } = render(<Markdown>{"```\nsecret = 1\n```"}</Markdown>);
    await userEvent.click(screen.getByRole("button", { name: "Copy the code" }));
    expect(container.querySelector("pre")?.textContent).toContain("secret = 1");
    expect(screen.queryByRole("button", { name: "Copied" })).toBeNull();
  });
});
