"use client";

import { CONFIG_BOUNDS } from "@invisible-dots/shared/browser";
import type { ReactNode } from "react";
import { setField } from "../../lib/config-fields";
import { FORM_BOUNDS, gibOf, gibSize, IDLE_CHOICES, MODEL_SUGGESTIONS } from "../../lib/dot-form";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { Switch } from "../ui/switch";
import { Textarea } from "../ui/textarea";
import { Field, NumberField, SliderField } from "../new-dot/Field";
import { MEMORY_EFFECT } from "../memory/memory-switch";
import { Panel, type PanelProps } from "./panel";

export function GeneralPanel({ draft, change, errorOf }: PanelProps) {
  return (
    <Panel id="general" title="General" description="Who this Dot is and what it is for.">
      <div className="space-y-1">
        <p className="text-sm font-medium">Name</p>
        <p>
          <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-sm">{draft.name}</code>
        </p>
        <p className="text-xs text-muted-foreground">A Dot keeps its name: it names the Dot in commands, logs and every page.</p>
        {errorOf("name") ? <p className="text-xs text-danger">{errorOf("name")}</p> : null}
      </div>
      <Field id="set-goal" label="Goal" hint="What the Dot should achieve, in a sentence or two." error={errorOf("goal")}>
        {(control) => <Textarea {...control} rows={3} value={draft.goal} onChange={(event) => change(setField(draft, "goal", event.target.value))} />}
      </Field>
      <Field id="set-instructions" label="Instructions" optional hint="How it should work: where to write, what to avoid, what a good result looks like." error={errorOf("instructions")}>
        {(control) => <Textarea {...control} rows={4} value={draft.instructions ?? ""} onChange={(event) => change(setField(draft, "instructions", event.target.value))} />}
      </Field>
    </Panel>
  );
}

export function ModelPanel({ draft, change, errorOf }: PanelProps) {
  return (
    <Panel id="model" title="Model" description="The models that do its thinking, through OpenRouter.">
      <Field id="set-model" label="Model" hint="Does all of the Dot's work. An OpenRouter model id: pick a suggestion or type any other." error={errorOf("model.id")}>
        {(control) => <Input {...control} list="set-model-suggestions" value={draft.model.id} autoComplete="off" spellCheck={false} onChange={(event) => change(setField(draft, "model.id", event.target.value))} />}
      </Field>
      <Field
        id="set-summary-model"
        label="Summary model"
        optional
        hint="Writes the summary when a conversation grows past what fits in the context. Left empty, the Dot's own model does."
        error={errorOf("models.summary")}
      >
        {(control) => (
          <Input {...control} list="set-model-suggestions" value={draft.models.summary ?? ""} autoComplete="off" spellCheck={false} onChange={(event) => change(setField(draft, "models.summary", event.target.value))} />
        )}
      </Field>
      <datalist id="set-model-suggestions">
        {MODEL_SUGGESTIONS.map((id) => (
          <option key={id} value={id} />
        ))}
      </datalist>
    </Panel>
  );
}

export function ComputerPanel({ draft, saved, change, errorOf }: PanelProps) {
  const { computer } = draft;
  // A disk can grow but never shrink: the filesystem on it would be destroyed. The slider starts at what the disk is.
  const diskFloor = Math.max(FORM_BOUNDS.diskGib.min, gibOf(saved.computer.disk));
  // A timeout the config has that the list does not offer stays selectable, instead of being replaced by a default.
  const known = IDLE_CHOICES.some((choice) => choice.value === computer.idle_timeout);
  return (
    <Panel id="computer" title="Computer" description="The computer the Dot works on. Its size applies the next time the computer starts.">
      <SliderField id="set-cpu" label="Processors" unit="cores" min={FORM_BOUNDS.cpu.min} max={FORM_BOUNDS.cpu.max} value={computer.cpu} onChange={(cpu) => change(setField(draft, "computer.cpu", cpu))} error={errorOf("computer.cpu")} />
      <SliderField
        id="set-memory"
        label="Memory"
        unit="GB"
        min={FORM_BOUNDS.memoryGib.min}
        max={FORM_BOUNDS.memoryGib.max}
        value={gibOf(computer.memory)}
        onChange={(gib) => change(setField(draft, "computer.memory", gibSize(gib)))}
        error={errorOf("computer.memory")}
      />
      <SliderField
        id="set-disk"
        label="Disk"
        unit="GB"
        min={diskFloor}
        max={FORM_BOUNDS.diskGib.max}
        value={gibOf(computer.disk)}
        onChange={(gib) => change(setField(draft, "computer.disk", gibSize(gib)))}
        hint={`It can grow but never shrink: this one is ${saved.computer.disk} now.`}
        error={errorOf("computer.disk")}
      />
      <Field id="set-idle" label="Sleep after" hint="The computer powers off after this long with nothing to do, and wakes when needed." error={errorOf("computer.idle_timeout")}>
        {(control) => (
          <select
            {...control}
            value={computer.idle_timeout}
            onChange={(event) => change(setField(draft, "computer.idle_timeout", event.target.value))}
            className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm shadow-xs focus-visible:outline-hidden focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/80 sm:w-56"
          >
            {IDLE_CHOICES.map((choice) => (
              <option key={choice.value} value={choice.value}>
                {choice.label}
              </option>
            ))}
            {known ? null : <option value={computer.idle_timeout}>{computer.idle_timeout}</option>}
          </select>
        )}
      </Field>
    </Panel>
  );
}

/** A switch with what it means in words: its label says the state, the text under it says what that does. */
function SwitchRow({ id, label, meaning, checked, onChange, children }: { id: string; label: string; meaning: string; checked: boolean; onChange: (next: boolean) => void; children?: ReactNode }) {
  return (
    <div className="flex items-start gap-3">
      <div className="min-w-0 flex-1 space-y-1">
        <Label htmlFor={id} className="text-sm font-medium">
          {label}
        </Label>
        <p className="text-sm text-muted-foreground">{meaning}</p>
        {children}
      </div>
      <Switch id={id} checked={checked} onCheckedChange={onChange} />
    </div>
  );
}

export function BrowserPanel({ draft, change, errorOf }: PanelProps) {
  const identities = draft.browser.identities;
  return (
    <Panel id="browser" title="Browser" description="The browser identities the Dot works with: each its own profile, with its own logins.">
      <SwitchRow
        id="set-managed"
        label={identities.managed_by_dot ? "The Dot manages its identities" : "You manage its identities"}
        meaning={
          identities.managed_by_dot
            ? "The Dot may create and delete browser identities itself, as far as its permissions allow."
            : "The Dot is not offered the tools that create and delete identities. You make them on the Computer page."
        }
        checked={identities.managed_by_dot}
        onChange={(next) => change(setField(draft, "browser.identities.managed_by_dot", next))}
      />
      <NumberField
        id="set-max-identities"
        label="Most identities"
        min={CONFIG_BOUNDS.maxIdentities.min}
        max={CONFIG_BOUNDS.maxIdentities.max}
        step={1}
        value={identities.max_identities}
        onChange={(value) => change(setField(draft, "browser.identities.max_identities", value))}
        hint="No identity can be made past this, by the Dot or by you."
        error={errorOf("browser.identities.max_identities")}
      />
      <NumberField
        id="set-max-open"
        label="Most open at once"
        min={CONFIG_BOUNDS.maxOpen.min}
        max={CONFIG_BOUNDS.maxOpen.max}
        step={1}
        value={identities.max_open}
        onChange={(value) => change(setField(draft, "browser.identities.max_open", value))}
        hint="Each open browser uses the computer's memory. It cannot be more than the most identities."
        error={errorOf("browser.identities.max_open")}
      />
    </Panel>
  );
}

export function MemoryPanel({ draft, change }: PanelProps) {
  return (
    <Panel id="memory" title="Memory" description="Whether the Dot keeps notes for later.">
      <SwitchRow
        id="set-memory-enabled"
        label={draft.memory.enabled ? "Memory is on" : "Memory is off"}
        meaning={draft.memory.enabled ? MEMORY_EFFECT.on : MEMORY_EFFECT.off}
        checked={draft.memory.enabled}
        onChange={(next) => change(setField(draft, "memory.enabled", next))}
      />
    </Panel>
  );
}

export function LimitsPanel({ draft, change, errorOf }: PanelProps) {
  const { limits } = draft;
  return (
    <Panel id="limits" title="Limits" description="How much one task or one conversation may use before it stops.">
      <NumberField
        id="set-cost"
        label="Spending cap per task"
        unit="USD"
        min={FORM_BOUNDS.maxCostUsd.min}
        max={FORM_BOUNDS.maxCostUsd.max}
        step={0.01}
        value={limits.max_cost_per_task_usd}
        onChange={(value) => change(setField(draft, "limits.max_cost_per_task_usd", value))}
        hint="A task, or a chat turn, stops when its model calls have cost this much. The last request may go over."
        error={errorOf("limits.max_cost_per_task_usd")}
      />
      <NumberField
        id="set-steps"
        label="Steps per task"
        min={CONFIG_BOUNDS.maxStepsPerTask.min}
        max={CONFIG_BOUNDS.maxStepsPerTask.max}
        step={1}
        value={limits.max_steps_per_task}
        onChange={(value) => change(setField(draft, "limits.max_steps_per_task", value))}
        hint="Model turns a task may take before it fails."
        error={errorOf("limits.max_steps_per_task")}
      />
      <NumberField
        id="set-context"
        label="Context tokens"
        min={CONFIG_BOUNDS.contextTokens.min}
        max={CONFIG_BOUNDS.contextTokens.max}
        step={1000}
        value={limits.context_tokens}
        onChange={(value) => change(setField(draft, "limits.context_tokens", value))}
        hint="The most prompt a request may carry. When a conversation outgrows it, the older part is summarised."
        error={errorOf("limits.context_tokens")}
      />
    </Panel>
  );
}
