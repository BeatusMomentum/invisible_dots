"use client";

import { AlertCircleIcon } from "lucide-react";
import { issueText, type FormIssue } from "../lib/dot-form";
import { cn } from "../lib/utils";
import { Alert, AlertDescription, AlertTitle } from "./ui/alert";
import { Textarea } from "./ui/textarea";

/**
 * A Dot's whole config as YAML text, with what is wrong with it as it is typed. The text is the person's until it is
 * valid; the shared schema is the only judge, and `issues` are its words. Both the create page and the Dot's
 * settings use it, so the config reads the same in both.
 */
export function ConfigYamlEditor({
  yaml,
  onChange,
  issues,
  refusal,
  hint,
}: {
  yaml: string;
  onChange: (text: string) => void;
  issues: FormIssue[];
  /** Why the text cannot go back to the form, when the person tried and it cannot. */
  refusal: FormIssue[] | null;
  hint: string;
}) {
  return (
    <section aria-labelledby="yaml-title" className="space-y-3 rounded-lg border bg-card p-5">
      <div>
        <h2 id="yaml-title" className="text-base font-semibold">
          Configuration (YAML)
        </h2>
        <p id="yaml-hint" className="text-sm text-muted-foreground">
          {hint}
        </p>
      </div>
      <Textarea
        aria-labelledby="yaml-title"
        aria-describedby="yaml-hint"
        aria-invalid={issues.length > 0 ? true : undefined}
        className={cn("min-h-96 font-mono text-[13px] leading-5")}
        spellCheck={false}
        value={yaml}
        onChange={(event) => onChange(event.target.value)}
      />
      {issues.length > 0 ? (
        <ul aria-label="Problems in the YAML" className="list-disc space-y-0.5 pl-4 text-sm text-danger">
          {issues.map((issue, i) => (
            <li key={i}>{issueText(issue)}</li>
          ))}
        </ul>
      ) : (
        <p className="text-sm text-ok">The configuration is valid.</p>
      )}
      {refusal ? (
        <Alert>
          <AlertCircleIcon />
          <AlertTitle>The form cannot show this</AlertTitle>
          <AlertDescription>{refusal.map(issueText).join(" ")}</AlertDescription>
        </Alert>
      ) : null}
    </section>
  );
}
