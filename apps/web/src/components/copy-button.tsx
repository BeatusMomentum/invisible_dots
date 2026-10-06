"use client";

import { CheckIcon, CopyIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { cn } from "../lib/utils";

const COPIED_MS = 1500;

/**
 * A small button that puts a text on the clipboard and says so for a moment. `label` is what it is called until it
 * has copied ("Copy the code"); a clipboard that refuses (an insecure page, a denied permission) leaves the button as
 * it was, because the text is on the page and can still be selected. `text` may be a function, read at the click.
 */
export function CopyButton({ text, label, className }: { text: string | (() => string); label: string; className?: string }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);

  async function copy() {
    try {
      await navigator.clipboard.writeText(typeof text === "function" ? text() : text);
      setCopied(true);
      clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false), COPIED_MS);
    } catch {
      // Refused: nothing to say that the text on the page does not already allow.
    }
  }

  return (
    <button
      type="button"
      onClick={() => void copy()}
      aria-label={copied ? "Copied" : label}
      className={cn(
        "rounded-md border bg-card p-1 text-muted-foreground focus-visible:outline-hidden hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/80",
        className,
      )}
    >
      {copied ? <CheckIcon aria-hidden="true" className="size-3.5" /> : <CopyIcon aria-hidden="true" className="size-3.5" />}
    </button>
  );
}
