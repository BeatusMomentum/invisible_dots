"use client";

import { PlusIcon } from "lucide-react";
import { useState, type FormEvent } from "react";
import { toast } from "sonner";
import { api } from "../../lib/api";
import { newIdentity, type IdentityLimits } from "../../lib/identity";
import { ErrorAlert } from "../ErrorAlert";
import { Field } from "../new-dot/Field";
import { useAction } from "../ui";
import { Button } from "../ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "../ui/dialog";
import { Input } from "../ui/input";

/**
 * The "New browser" button and its dialog: a name, and optionally a proxy the browser goes out through. The control
 * plane enforces the limits (and says so when one is reached), so the form checks only what it can say at once.
 */
export function NewIdentityDialog({ dotId, existing, limits, onCreated }: { dotId: string; existing: number; limits: IdentityLimits; onCreated: () => void }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [proxy, setProxy] = useState("");
  const [touched, setTouched] = useState(false);
  const action = useAction();
  const checked = newIdentity(name, proxy, existing, limits);

  function change(next: boolean) {
    setOpen(next);
    if (next) return;
    setName("");
    setProxy("");
    setTouched(false);
    action.setError(null);
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    setTouched(true);
    if (!checked.ok) return;
    const request = checked.request;
    const ok = await action.run(() => api.createIdentity(dotId, request));
    if (ok) {
      change(false);
      toast.success("The browser was created. It is closed until the Dot opens it.");
      onCreated();
    }
  }

  return (
    <Dialog open={open} onOpenChange={change}>
      <DialogTrigger asChild>
        <Button type="button">
          <PlusIcon />
          New browser
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>New browser</DialogTitle>
          <DialogDescription>A browser has a profile of its own: cookies, logins, history. It starts closed, and the Dot opens it when it needs it.</DialogDescription>
        </DialogHeader>
        <form onSubmit={(event) => void submit(event)} className="space-y-4" noValidate>
          <Field id="identity-name" label="Name" hint="What the Dot calls it, for example the site it logs in to.">
            {(control) => <Input {...control} value={name} onChange={(e) => setName(e.target.value)} autoFocus />}
          </Field>
          <Field
            id="identity-proxy"
            label="Proxy"
            optional
            hint="Where the browser goes out through: http://host:port, https://, socks4:// or socks5://, with user:password@ if it needs a login. The password stays on the Dot's computer and is shown nowhere again; while the browser is open, the Dot's own commands could read it from the browser's process."
          >
            {(control) => <Input {...control} value={proxy} autoComplete="off" spellCheck={false} placeholder="socks5://host:1080" onChange={(e) => setProxy(e.target.value)} />}
          </Field>
          {touched && !checked.ok ? (
            <p role="alert" className="text-sm text-danger">
              {checked.problem}
            </p>
          ) : null}
          <ErrorAlert error={action.error} title="The browser was not created" />
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => change(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={action.pending}>
              {action.pending ? "Creating..." : "Create browser"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
