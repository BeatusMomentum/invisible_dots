import { describe, expect, it } from "vitest";
import { serveFile } from "../src/file-types.js";

describe("serveFile: what a browser may be told a Dot's file is", () => {
  it("serves images as images and text as plain text, inline", () => {
    expect(serveFile("/home/dot/a.png")).toMatchObject({ contentType: "image/png" });
    expect(serveFile("/home/dot/a.JPG")).toMatchObject({ contentType: "image/jpeg" });
    expect(serveFile("/home/dot/a.jpeg")).toMatchObject({ contentType: "image/jpeg" });
    expect(serveFile("/home/dot/a.gif")).toMatchObject({ contentType: "image/gif" });
    expect(serveFile("/home/dot/a.webp")).toMatchObject({ contentType: "image/webp" });
    for (const name of ["a.md", "a.txt", "a.json", "a.py", "a.CSV", "a.yaml", "memory/trips/a.log"]) {
      expect(serveFile(`/home/dot/${name}`), name).toMatchObject({ contentType: "text/plain; charset=utf-8" });
      expect(serveFile(`/home/dot/${name}`).disposition, name).toMatch(/^inline;/);
    }
  });

  it("never serves markup or script as what it is: html, svg, xml and javascript are text", () => {
    for (const name of ["a.html", "a.htm", "a.svg", "a.xml", "a.js", "a.mjs"]) {
      expect(serveFile(`/home/dot/${name}`).contentType, name).toBe("text/plain; charset=utf-8");
    }
  });

  it("makes everything else a download", () => {
    for (const name of ["a.bin", "a.pdf", "a.zip", "Makefile", ".bashrc", "a.", "archive.tar.gz", "a.png.exe"]) {
      const served = serveFile(`/home/dot/${name}`);
      expect(served.contentType, name).toBe("application/octet-stream");
      expect(served.disposition, name).toMatch(/^attachment;/);
    }
  });

  it("names the file in both forms, with nothing in the plain one that could end the header value", () => {
    expect(serveFile("/home/dot/memory/fares.md").disposition).toBe(`inline; filename="fares.md"; filename*=UTF-8''fares.md`);
    expect(serveFile('/home/dot/é "q"\\100%.txt').disposition).toBe(
      `inline; filename="_ _q__100_.txt"; filename*=UTF-8''%C3%A9%20%22q%22%5C100%25.txt`,
    );
    expect(serveFile("/home/dot/a\r\nx-evil: 1.txt").disposition).not.toMatch(/[\r\n]/);
  });
});
