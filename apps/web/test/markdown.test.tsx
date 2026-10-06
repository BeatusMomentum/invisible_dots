// @vitest-environment jsdom
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { Markdown } from "../src/components/markdown";

afterEach(cleanup);

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
});
