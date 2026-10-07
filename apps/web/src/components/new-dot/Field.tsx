"use client";

import { useEffect, useState, type ReactNode } from "react";
import { Input } from "../ui/input";
import { Label } from "../ui/label";

export interface ControlProps {
  id: string;
  "aria-describedby": string | undefined;
  "aria-invalid": true | undefined;
}

/**
 * A labelled form control with its hint and its problem. The control is rendered by `children` so that it gets the
 * id and the aria attributes that tie the label, the hint and the error to it.
 */
export function Field({
  id,
  label,
  optional = false,
  hint,
  error,
  children,
}: {
  id: string;
  label: string;
  optional?: boolean;
  hint?: ReactNode;
  error?: string | null;
  children: (control: ControlProps) => ReactNode;
}) {
  const describedBy = [hint ? `${id}-hint` : null, error ? `${id}-error` : null].filter(Boolean).join(" ") || undefined;
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id}>
        {label}
        {optional ? <span className="font-normal text-muted-foreground"> (optional)</span> : null}
      </Label>
      {children({ id, "aria-describedby": describedBy, "aria-invalid": error ? true : undefined })}
      {hint ? (
        <p id={`${id}-hint`} className="text-xs text-muted-foreground">
          {hint}
        </p>
      ) : null}
      {error ? (
        <p id={`${id}-error`} className="text-xs text-danger">
          {error}
        </p>
      ) : null}
    </div>
  );
}

/**
 * The text of a number field while it is being typed. It is the field's own (it may be empty or half a number);
 * the value changes only when the text is a number in range, and the text follows the value again when something
 * else moves it (a slider) or the field loses focus.
 */
function useTypedNumber(value: number, onChange: (value: number) => void, min: number, max: number) {
  const [text, setText] = useState(String(value));
  useEffect(() => {
    setText((current) => (Number(current) === value ? current : String(value)));
  }, [value]);
  return {
    text,
    onTextChange(next: string, typed: number) {
      setText(next);
      if (Number.isFinite(typed) && typed >= min && typed <= max) onChange(typed);
    },
    resetText: () => setText(String(value)),
  };
}

/** A number typed into a field, inside the schema's range. */
export function NumberField({
  id,
  label,
  unit,
  min,
  max,
  step,
  value,
  onChange,
  hint,
  error,
}: {
  id: string;
  label: string;
  unit?: string;
  min: number;
  max: number;
  step: number;
  value: number;
  onChange: (value: number) => void;
  hint?: ReactNode;
  error?: string | null;
}) {
  const typed = useTypedNumber(value, onChange, min, max);
  return (
    <Field id={id} label={label} hint={hint} error={error}>
      {(control) => (
        <div className="flex items-center gap-1.5">
          <Input
            {...control}
            type="number"
            inputMode="decimal"
            min={min}
            max={max}
            step={step}
            value={typed.text}
            onChange={(event) => typed.onTextChange(event.target.value, event.target.valueAsNumber)}
            onBlur={typed.resetText}
            className="w-28"
          />
          {unit ? <span className="text-xs text-muted-foreground">{unit}</span> : null}
        </div>
      )}
    </Field>
  );
}

/** A number with a slider and a field to type it into, both inside the schema's range. */
export function SliderField({
  id,
  label,
  unit,
  min,
  max,
  step = 1,
  value,
  onChange,
  hint,
  error,
}: {
  id: string;
  label: string;
  unit: string;
  min: number;
  max: number;
  step?: number;
  value: number;
  onChange: (value: number) => void;
  hint?: ReactNode;
  error?: string | null;
}) {
  const typed = useTypedNumber(value, onChange, min, max);
  return (
    <Field id={id} label={label} hint={hint} error={error}>
      {(control) => (
        <div className="flex items-center gap-3">
          <input
            {...control}
            type="range"
            min={min}
            max={max}
            step={step}
            value={value}
            onChange={(event) => onChange(Number(event.target.value))}
            className="h-2 min-w-0 flex-1 cursor-pointer accent-primary"
          />
          <span className="flex shrink-0 items-center gap-1.5">
            <Input
              type="number"
              inputMode="decimal"
              aria-label={`${label}, exact value`}
              min={min}
              max={max}
              step={step}
              value={typed.text}
              onChange={(event) => typed.onTextChange(event.target.value, event.target.valueAsNumber)}
              onBlur={typed.resetText}
              className="h-8 w-20 text-right"
            />
            <span className="w-7 text-xs text-muted-foreground">{unit}</span>
          </span>
        </div>
      )}
    </Field>
  );
}
