import { describe, expect, it } from "vitest";
import { fileType } from "../src/file-kinds.js";

describe("fileType: what a Dot's file is, by its name", () => {
  it("knows the images a page may draw, whatever the case", () => {
    expect(fileType("a.png")).toEqual({ kind: "image", contentType: "image/png" });
    expect(fileType("A.JPG")).toEqual({ kind: "image", contentType: "image/jpeg" });
    expect(fileType("a.jpeg").contentType).toBe("image/jpeg");
    expect(fileType("a.gif").contentType).toBe("image/gif");
    expect(fileType("a.webp").contentType).toBe("image/webp");
  });

  it("calls text, markup and script text, and never an image: svg is read as text, never drawn", () => {
    for (const name of ["a.md", "a.txt", "a.json", "a.py", "a.CSV", "a.html", "a.htm", "a.svg", "a.xml", "a.js", "a.mjs"]) {
      expect(fileType(name), name).toEqual({ kind: "text", contentType: "text/plain; charset=utf-8" });
    }
  });

  it("leaves everything else as neither, however the name ends", () => {
    for (const name of ["a.bin", "a.pdf", "Makefile", ".bashrc", "a.", "archive.tar.gz", "a.png.exe"]) {
      expect(fileType(name), name).toEqual({ kind: "other", contentType: "application/octet-stream" });
    }
  });

  it("reads the name after the last slash, so a dot in a folder does not give a file its type", () => {
    expect(fileType("/home/dot/notes.d/readme").kind).toBe("other");
    expect(fileType("/home/dot/memory/fares.md").kind).toBe("text");
  });
});
