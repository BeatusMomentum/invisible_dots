"use client";

import { AlertCircleIcon } from "lucide-react";
import { useRouter } from "next/navigation";
import { useMemo, useRef, useState, type FormEvent } from "react";
import { api } from "../../lib/api";
import { configIssues, emptyForm, formIssues, formToConfig, formToYaml, issueText, yamlToForm, type DotForm, type FieldId, type FormIssue } from "../../lib/dot-form";
import { ErrorAlert } from "../ErrorAlert";
import { useShell } from "../shell/attention";
import { useAction } from "../ui";
import { Alert, AlertDescription, AlertTitle } from "../ui/alert";
import { Button } from "../ui/button";
import { BrainSection, ComputerSection, IdentitySection, type SectionProps } from "./FormSections";
import { ConfigYamlEditor } from "../yaml-editor";
import { PreflightPanel } from "./PreflightPanel";

type Mode = "form" | "yaml";

/**
 * Create a Dot (S3): a form in three steps on one page, or the same config as YAML, and beside it what the new
 * Dot depends on. The shared schema judges both, so the page never lets through what the API would refuse. A
 * Dot is created with `POST /api/dots`; the person lands in its chat, where its computer is being prepared.
 */
export function NewDotPage() {
  const router = useRouter();
  const { dots } = useShell();
  const takenNames = useMemo(() => (dots.data ?? []).map((dot) => dot.name), [dots.data]);
  const [mode, setMode] = useState<Mode>("form");
  const [form, setForm] = useState<DotForm>(emptyForm);
  const [yaml, setYaml] = useState("");
  const [refusal, setRefusal] = useState<FormIssue[] | null>(null);
  const [touched, setTouched] = useState<ReadonlySet<FieldId>>(new Set());
  const [attempted, setAttempted] = useState(false);
  const create = useAction();
  const summary = useRef<HTMLDivElement>(null);

  const issues = mode === "form" ? formIssues(form, takenNames) : configIssues(yaml, takenNames);

  const sections: SectionProps = {
    form,
    change: (change) => setForm((current) => ({ ...current, ...change })),
    errorOf: (field) => (attempted || touched.has(field) ? (issues.find((issue) => issue.field === field)?.message ?? null) : null),
    touch: (field) => setTouched((current) => (current.has(field) ? current : new Set(current).add(field))),
  };

  function toYamlMode() {
    setYaml(formToYaml(form));
    setRefusal(null);
    setMode("yaml");
  }

  function toFormMode() {
    const read = yamlToForm(yaml);
    if (read.ok) {
      setForm(read.form);
      setRefusal(null);
      setMode("form");
    } else {
      setRefusal(read.issues);
    }
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    setAttempted(true);
    if (issues.length > 0) {
      // The summary is where the person's attention goes: the controls with a problem are listed there.
      requestAnimationFrame(() => summary.current?.focus());
      return;
    }
    await create.run(async () => {
      const dot = await api.createDot(mode === "form" ? formToConfig(form) : yaml);
      router.push(`/dots/${encodeURIComponent(dot.id)}/chat`);
    });
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Create a Dot</h1>
          <p className="text-sm text-muted-foreground">A Dot is an agent with a computer of its own. Describe it, and it starts working on it.</p>
        </div>
        <div role="group" aria-label="How to describe it" className="inline-flex rounded-md border p-0.5">
          <Button type="button" size="sm" variant={mode === "form" ? "secondary" : "ghost"} aria-pressed={mode === "form"} onClick={mode === "yaml" ? toFormMode : undefined}>
            Form
          </Button>
          <Button type="button" size="sm" variant={mode === "yaml" ? "secondary" : "ghost"} aria-pressed={mode === "yaml"} onClick={mode === "form" ? toYamlMode : undefined}>
            Advanced YAML
          </Button>
        </div>
      </div>

      <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_18rem]">
        <form onSubmit={submit} noValidate className="min-w-0 space-y-5" aria-label="New Dot">
          {mode === "form" ? (
            <>
              <IdentitySection {...sections} />
              <BrainSection {...sections} />
              <ComputerSection {...sections} />
            </>
          ) : (
            <ConfigYamlEditor
              yaml={yaml}
              onChange={(text) => {
                setYaml(text);
                setRefusal(null);
              }}
              issues={issues}
              refusal={refusal}
              hint="The same configuration as the form, with every option the schema has. The server validates it again when you create the Dot."
            />
          )}

          {attempted && issues.length > 0 ? (
            <div ref={summary} tabIndex={-1} className="focus-visible:outline-hidden">
              <Alert variant="destructive">
                <AlertCircleIcon />
                <AlertTitle>{issues.length === 1 ? "One thing to fix before the Dot can be created" : `${issues.length} things to fix before the Dot can be created`}</AlertTitle>
                <AlertDescription>
                  <ul className="list-disc pl-4">
                    {issues.map((issue, i) => (
                      <li key={i}>{issueText(issue)}</li>
                    ))}
                  </ul>
                </AlertDescription>
              </Alert>
            </div>
          ) : null}
          <ErrorAlert error={create.error} title="The Dot was not created" />

          <div className="flex items-center gap-3">
            <Button type="submit" disabled={create.pending}>
              {create.pending ? "Creating..." : "Create Dot"}
            </Button>
            <p className="text-xs text-muted-foreground">Its computer takes a few minutes to prepare. You can talk to it meanwhile.</p>
          </div>
        </form>

        <aside aria-label="Checks" className="lg:sticky lg:top-6">
          <PreflightPanel />
        </aside>
      </div>
    </div>
  );
}
