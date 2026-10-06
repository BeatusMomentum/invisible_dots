"use client";

import { useEffect, useState, type FormEvent } from "react";
import { api } from "../../lib/api";
import { ErrorAlert } from "../ErrorAlert";
import { Field } from "../new-dot/Field";
import { useAction } from "../ui";
import { Button } from "../ui/button";
import { Input } from "../ui/input";

/**
 * The Dot's VM proxy: the whole computer of the Dot goes out through it, the browser included, which then takes its
 * time zone and language from that exit. Write-only like the OpenRouter key: the control plane keeps it encrypted and
 * says only whether one is set. A change is used from the Dot's next start.
 */
export function VmProxy({ dotId }: { dotId: string }) {
  const [configured, setConfigured] = useState<boolean | null>(null);
  const [value, setValue] = useState("");
  const [saved, setSaved] = useState<string | null>(null);
  const save = useAction();

  useEffect(() => {
    let live = true;
    void api.vmProxy(dotId).then((answer) => live && setConfigured(answer.proxy), () => live && setConfigured(null));
    return () => {
      live = false;
    };
  }, [dotId]);

  async function apply(next: string | null) {
    setSaved(null);
    await save.run(async () => {
      const answer = await api.setVmProxy(dotId, next);
      setConfigured(answer.proxy);
      setValue("");
      setSaved(answer.proxy ? "Saved. The Dot uses it from its next start." : "Removed. The Dot goes out directly from its next start.");
    });
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    if (value.trim() !== "") void apply(value.trim());
  }

  return (
    <section aria-labelledby="vm-proxy-title" className="space-y-3 rounded-lg border p-4">
      <h2 id="vm-proxy-title" className="text-base font-semibold">
        VM proxy
      </h2>
      <p className="text-sm text-muted-foreground">
        {configured === null ? "" : configured ? "This Dot goes out through its proxy." : "This Dot goes out directly, from your own address."}
      </p>
      <form onSubmit={submit} className="space-y-3">
        <Field id="vm-proxy" label={configured ? "Replace the proxy" : "Proxy"} hint="socks5://user:password@host:port. Stored encrypted and never shown again.">
          {(control) => (
            <Input {...control} type="password" autoComplete="off" spellCheck={false} placeholder="socks5://host:1080" value={value} onChange={(event) => setValue(event.target.value)} />
          )}
        </Field>
        <div className="flex flex-wrap items-center gap-2">
          <Button type="submit" size="sm" disabled={save.pending || value.trim() === ""}>
            {configured ? "Replace proxy" : "Save proxy"}
          </Button>
          {configured ? (
            <Button type="button" size="sm" variant="outline" disabled={save.pending} onClick={() => void apply(null)}>
              Remove proxy
            </Button>
          ) : null}
          {saved ? (
            <p role="status" className="text-sm text-ok">
              {saved}
            </p>
          ) : null}
        </div>
      </form>
      {save.error ? <ErrorAlert error={save.error} title="Could not save the proxy" /> : null}
    </section>
  );
}
