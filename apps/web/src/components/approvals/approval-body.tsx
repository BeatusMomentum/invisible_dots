"use client";

import type { ApprovalBody } from "../../lib/approval-view";
import { cn } from "../../lib/utils";
import { DiffPreview } from "./diff-preview";

/** A path or an address the call acts on, in a box of its own. */
function Mono({ children, className }: { children: string; className?: string }) {
  return <code className={cn("block rounded-md bg-muted px-3 py-2 font-mono text-xs break-all whitespace-pre-wrap", className)}>{children}</code>;
}

/** What the Dot would do, in the form that reads best for the tool: a command, a diff, a list of facts. */
export function Body({ body }: { body: ApprovalBody }) {
  switch (body.kind) {
    case "command":
      return (
        <div className="space-y-1">
          <Mono className="max-h-48 overflow-auto">{body.command}</Mono>
          {body.where ? (
            <p className="text-xs text-muted-foreground">
              In <code className="font-mono break-all">{body.where}</code>
            </p>
          ) : null}
        </div>
      );
    case "write":
      return (
        <div className="space-y-2">
          <p className="text-xs text-muted-foreground">
            Writes the whole file <code className="font-mono break-all text-foreground">{body.path}</code>, replacing what is in it now.
          </p>
          <DiffPreview lines={body.diff} label={`New content of ${body.path}`} />
        </div>
      );
    case "edit":
      return (
        <div className="space-y-2">
          <p className="text-xs text-muted-foreground">
            Changes <code className="font-mono break-all text-foreground">{body.path}</code>
            {body.replaceAll ? ", every place the old text is found" : ""}.
          </p>
          <DiffPreview lines={body.diff} label={`Change to ${body.path}`} />
        </div>
      );
    case "patch":
      return (
        <div className="space-y-3">
          {body.dryRun ? <p className="text-xs text-muted-foreground">A trial run: nothing is written.</p> : null}
          {body.files.map((file, index) => (
            <div key={`${file.path}-${index}`} className="space-y-2">
              <p className="text-xs text-muted-foreground">
                {file.action === "add" ? "Adds to" : "Changes"} <code className="font-mono break-all text-foreground">{file.path}</code>
              </p>
              <DiffPreview lines={file.diff} label={`Change to ${file.path}`} />
            </div>
          ))}
        </div>
      );
    case "facts":
      return body.facts.length === 0 ? null : (
        <dl className="space-y-1.5 text-sm">
          {body.facts.map((fact, index) => (
            <div key={`${fact.label}-${index}`} className="grid grid-cols-[7rem_minmax(0,1fr)] gap-3">
              <dt className="text-xs text-muted-foreground">{fact.label}</dt>
              <dd className="font-mono text-xs break-all whitespace-pre-wrap">{fact.value}</dd>
            </div>
          ))}
        </dl>
      );
  }
}
