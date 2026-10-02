"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState, type FormEvent } from "react";
import { api } from "../lib/api";
import { toYaml } from "../lib/yaml";
import { useDot } from "./DotShell";
import { ErrorBox, useAction } from "./ui";

export function SettingsTab() {
  const { dotId, dot } = useDot();
  const router = useRouter();
  const [yaml, setYaml] = useState("");
  const [dirty, setDirty] = useState(false);
  const [saved, setSaved] = useState(false);
  const save = useAction();
  const remove = useAction();

  // Follow the stored config until the user starts editing; never overwrite their edits.
  const stored = dot.data?.config;
  useEffect(() => {
    if (stored && !dirty) setYaml(toYaml(stored));
  }, [stored, dirty]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setSaved(false);
    const ok = await save.run(async () => {
      const updated = await api.updateDot(dotId, yaml);
      if (updated?.config) setYaml(toYaml(updated.config));
    });
    if (ok) {
      setDirty(false);
      setSaved(true);
      dot.reload();
    }
  }

  function revert() {
    setDirty(false);
    setSaved(false);
    save.setError(null);
    if (stored) setYaml(toYaml(stored));
  }

  async function destroy() {
    const name = dot.data?.name ?? dotId;
    const typed = window.prompt(
      `Deleting "${name}" destroys its computer and its disk, with every file, memory and browser identity on it. Type the Dot's name to confirm.`,
    );
    if (typed !== name) return;
    const ok = await remove.run(() => api.deleteDot(dotId));
    if (ok) router.push("/");
  }

  return (
    <>
      <section className="card" aria-labelledby="config-heading">
        <h2 id="config-heading">Configuration</h2>
        <form onSubmit={submit}>
          <label htmlFor="config-yaml">Configuration (YAML)</label>
          <p className="hint" id="config-yaml-hint">
            The server validates the configuration and pushes it to the Dot when its computer is running.
          </p>
          <textarea
            id="config-yaml"
            className="code"
            rows={28}
            spellCheck={false}
            value={yaml}
            aria-describedby="config-yaml-hint"
            onChange={(e) => {
              setYaml(e.target.value);
              setDirty(true);
              setSaved(false);
            }}
          />
          <ErrorBox error={save.error} title="The configuration was not saved" />
          {saved ? (
            <p className="text-ok" role="status">
              Saved.
            </p>
          ) : null}
          <div className="actions">
            <button type="submit" disabled={save.pending || !dirty}>
              {save.pending ? "Saving..." : "Save"}
            </button>
            <button type="button" className="secondary" disabled={save.pending || !dirty} onClick={revert}>
              Discard changes
            </button>
          </div>
        </form>
      </section>
      <section className="card danger-zone" aria-labelledby="delete-heading">
        <h2 id="delete-heading">Delete this Dot</h2>
        <p>The computer, its disk and everything stored on it are destroyed. This cannot be undone.</p>
        <ErrorBox error={remove.error} title="The Dot was not deleted" />
        <div className="actions">
          <button type="button" className="danger" disabled={remove.pending} onClick={() => void destroy()}>
            {remove.pending ? "Deleting..." : "Delete Dot"}
          </button>
        </div>
      </section>
    </>
  );
}
