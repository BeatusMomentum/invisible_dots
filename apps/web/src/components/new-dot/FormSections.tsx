"use client";

import type { ReactNode } from "react";
import { FORM_BOUNDS, IDLE_CHOICES, MODEL_SUGGESTIONS, type DotForm, type FieldId } from "../../lib/dot-form";
import { Input } from "../ui/input";
import { Textarea } from "../ui/textarea";
import { Field, NumberField, SliderField } from "./Field";
import { PresetPicker } from "./PresetPicker";

/** What a section needs: the form, how to change it, and the problem of each control the person has reached. */
export interface SectionProps {
  form: DotForm;
  change: (change: Partial<DotForm>) => void;
  /** The message to show under a control, or null when it has none to show (yet). */
  errorOf: (field: FieldId) => string | null;
  /** The person has been in this control: its problem may be shown. */
  touch: (field: FieldId) => void;
}

function Section({ number, title, description, children }: { number: number; title: string; description: string; children: ReactNode }) {
  const id = `step-${number}`;
  return (
    <section aria-labelledby={id} className="space-y-4 rounded-lg border bg-card p-5">
      <div className="flex items-start gap-3">
        <span aria-hidden="true" className="flex size-6 shrink-0 items-center justify-center rounded-full bg-primary text-xs font-semibold text-primary-foreground">
          {number}
        </span>
        <div>
          <h2 id={id} className="text-base font-semibold">
            {title}
          </h2>
          <p className="text-sm text-muted-foreground">{description}</p>
        </div>
      </div>
      <div className="space-y-4">{children}</div>
    </section>
  );
}

export function IdentitySection({ form, change, errorOf, touch }: SectionProps) {
  return (
    <Section number={1} title="Identity" description="Who this Dot is and what it is for.">
      <Field
        id="dot-name"
        label="Name"
        hint="Lowercase letters, digits and dashes, up to 40. It names the Dot in commands and on every page."
        error={errorOf("name")}
      >
        {(control) => (
          <Input
            {...control}
            value={form.name}
            autoComplete="off"
            spellCheck={false}
            placeholder="fare-watch"
            maxLength={80}
            onChange={(event) => {
              touch("name");
              change({ name: event.target.value });
            }}
            onBlur={() => touch("name")}
          />
        )}
      </Field>
      <Field id="dot-goal" label="Goal" hint="What the Dot should achieve, in a sentence or two." error={errorOf("goal")}>
        {(control) => (
          <Textarea
            {...control}
            rows={3}
            value={form.goal}
            placeholder="Check one-way fares from Milan to Lisbon every morning and report the cheapest day."
            onChange={(event) => change({ goal: event.target.value })}
            onBlur={() => touch("goal")}
          />
        )}
      </Field>
      <Field id="dot-instructions" label="Instructions" optional hint="How it should work: where to write, what to avoid, what a good result looks like." error={errorOf("instructions")}>
        {(control) => <Textarea {...control} rows={4} value={form.instructions} onChange={(event) => change({ instructions: event.target.value })} />}
      </Field>
    </Section>
  );
}

export function BrainSection({ form, change, errorOf, touch }: SectionProps) {
  return (
    <Section number={2} title="Brain" description="The models that do its thinking, through OpenRouter.">
      <Field id="dot-model" label="Model" hint="An OpenRouter model id. Pick a suggestion or type any other." error={errorOf("modelId")}>
        {(control) => (
          <Input {...control} list="dot-model-suggestions" value={form.modelId} autoComplete="off" spellCheck={false} onChange={(event) => change({ modelId: event.target.value })} onBlur={() => touch("modelId")} />
        )}
      </Field>
      <Field
        id="dot-summary-model"
        label="Summary model"
        optional
        hint="Writes the summary when a conversation grows past what fits. Left empty, the Dot's own model does."
        error={errorOf("summaryModelId")}
      >
        {(control) => (
          <Input {...control} list="dot-model-suggestions" value={form.summaryModelId} autoComplete="off" spellCheck={false} onChange={(event) => change({ summaryModelId: event.target.value })} onBlur={() => touch("summaryModelId")} />
        )}
      </Field>
      <datalist id="dot-model-suggestions">
        {MODEL_SUGGESTIONS.map((id) => (
          <option key={id} value={id} />
        ))}
      </datalist>
    </Section>
  );
}

export function ComputerSection({ form, change, errorOf }: SectionProps) {
  // A timeout the YAML set that the list does not offer stays selectable, instead of being replaced by a default.
  const known = IDLE_CHOICES.some((choice) => choice.value === form.idleTimeout);
  return (
    <Section number={3} title="Computer and safety" description="The computer it works on, and how much it may do on its own.">
      <div className="space-y-4">
        <SliderField id="dot-cpu" label="Processors" unit="cores" min={FORM_BOUNDS.cpu.min} max={FORM_BOUNDS.cpu.max} value={form.cpu} onChange={(cpu) => change({ cpu })} error={errorOf("cpu")} />
        <SliderField id="dot-memory" label="Memory" unit="GB" min={FORM_BOUNDS.memoryGib.min} max={FORM_BOUNDS.memoryGib.max} value={form.memoryGib} onChange={(memoryGib) => change({ memoryGib })} error={errorOf("memoryGib")} />
        <SliderField id="dot-disk" label="Disk" unit="GB" min={FORM_BOUNDS.diskGib.min} max={FORM_BOUNDS.diskGib.max} value={form.diskGib} onChange={(diskGib) => change({ diskGib })} hint="It can grow later but never shrink." error={errorOf("diskGib")} />
      </div>
      <Field id="dot-idle" label="Sleep after" hint="The computer powers off after this long with nothing to do, and wakes when needed." error={errorOf("idleTimeout")}>
        {(control) => (
          <select
            {...control}
            value={form.idleTimeout}
            onChange={(event) => change({ idleTimeout: event.target.value })}
            className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 sm:w-56"
          >
            {IDLE_CHOICES.map((choice) => (
              <option key={choice.value} value={choice.value}>
                {choice.label}
              </option>
            ))}
            {known ? null : <option value={form.idleTimeout}>{form.idleTimeout}</option>}
          </select>
        )}
      </Field>
      <PresetPicker permissions={form.permissions} onChange={(permissions) => change({ permissions })} />
      <NumberField
        id="dot-cost"
        label="Spending cap per task"
        unit="USD"
        min={FORM_BOUNDS.maxCostUsd.min}
        max={FORM_BOUNDS.maxCostUsd.max}
        step={0.01}
        value={form.maxCostUsd}
        onChange={(maxCostUsd) => change({ maxCostUsd })}
        hint="A task, or a chat turn, stops when its model calls have cost this much. The last request may go over."
        error={errorOf("maxCostUsd")}
      />
      <p className="text-xs text-muted-foreground">Each permission can be changed one by one in the Dot&apos;s settings once it exists.</p>
    </Section>
  );
}
