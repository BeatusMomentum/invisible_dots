"use client";

import type { ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { cn } from "../lib/utils";
import { CopyButton } from "./copy-button";

/** The text of a node tree, as a reader sees it. */
function textOf(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join("");
  if (node && typeof node === "object" && "props" in node) return textOf((node as { props: { children?: ReactNode } }).props.children);
  return "";
}

/** A fenced block with a button that copies its text. */
function CodeBlock({ children }: { children?: ReactNode }) {
  return (
    <div className="group relative">
      <pre>{children}</pre>
      <CopyButton
        text={() => textOf(children).replace(/\n$/, "")}
        label="Copy the code"
        className="absolute top-1.5 right-1.5 opacity-0 transition-opacity group-hover:opacity-100 pointer-coarse:opacity-100 focus-visible:opacity-100"
      />
    </div>
  );
}

/**
 * Text a Dot wrote, as markdown. Raw HTML in it is never rendered (react-markdown drops it), links open in a new
 * tab without sending the page's address along, an image is shown as a link to it (a page the Dot read can ask for
 * any address, and loading it would tell that address who is looking), and nothing in it can reach the page's own
 * styles. A fenced block has a copy button.
 */
export function Markdown({ children, className }: { children: string; className?: string }) {
  return (
    <div className={cn("space-y-3 text-sm leading-relaxed break-words [&_code]:rounded [&_code]:bg-muted [&_code]:px-1 [&_code]:font-mono [&_code]:text-[0.85em] [&_ol]:list-decimal [&_ol]:pl-5 [&_pre]:overflow-x-auto [&_pre]:rounded-md [&_pre]:bg-muted [&_pre]:p-3 [&_pre_code]:bg-transparent [&_pre_code]:p-0 [&_table]:block [&_table]:overflow-x-auto [&_td]:border [&_td]:px-2 [&_td]:py-1 [&_th]:border [&_th]:px-2 [&_th]:py-1 [&_ul]:list-disc [&_ul]:pl-5", className)}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ node: _node, ...props }) => <a {...props} target="_blank" rel="noreferrer" className="text-primary underline underline-offset-2" />,
          img: ({ node: _node, src, alt }) =>
            typeof src === "string" ? (
              <a href={src} target="_blank" rel="noreferrer" className="text-primary underline underline-offset-2">
                {alt ? `Image: ${alt}` : "Image"}
              </a>
            ) : null,
          pre: ({ node: _node, children: code }) => <CodeBlock>{code}</CodeBlock>,
        }}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
}
