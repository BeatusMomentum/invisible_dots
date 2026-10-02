"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { api } from "../lib/api";
import { formatDate } from "../lib/format";
import { truncate } from "../lib/timeline";
import { EXAMPLE_CONFIG } from "../lib/yaml";
import { StreamIndicator, useLiveRefresh } from "./events";
import { ErrorBox, StatusBadge, useAction, useResource } from "./ui";

const LIST_EVENTS = [
  "dot.created",
  "dot.updated",
  "dot.deleted",
  "computer.state",
  "computer.started",
  "computer.stopped",
  "agent.state",
];

export function DotsPage() {
  const dots = useResource(() => api.listDots(), "dots");
  useLiveRefresh(dots.reload, LIST_EVENTS);

  return (
    <>
      <div className="page-head">
        <h1>Dots</h1>
        <StreamIndicator />
      </div>
      <ErrorBox error={dots.error} title="Could not load Dots" />
      {dots.data && dots.data.length === 0 ? <p className="muted">No Dots yet. Create one below.</p> : null}
      {dots.data && dots.data.length > 0 ? (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th scope="col">Name</th>
                <th scope="col">Status</th>
                <th scope="col">Computer</th>
                <th scope="col">Model</th>
                <th scope="col">Goal</th>
                <th scope="col">Updated</th>
              </tr>
            </thead>
            <tbody>
              {dots.data.map((dot) => (
                <tr key={dot.id}>
                  <td>
                    <Link href={`/dots/${encodeURIComponent(dot.id)}/chat`}>{dot.name}</Link>
                  </td>
                  <td>
                    <StatusBadge status={dot.status} />
                  </td>
                  <td>{dot.computer_state ? <StatusBadge status={dot.computer_state} /> : <span className="muted">-</span>}</td>
                  <td>
                    <code>{dot.config?.model?.id ?? "-"}</code>
                  </td>
                  <td>{truncate(dot.config?.goal ?? "", 120)}</td>
                  <td>{formatDate(dot.updated_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
      {dots.loading && !dots.data ? <p className="muted">Loading...</p> : null}
      <CreateDot />
    </>
  );
}

function CreateDot() {
  const router = useRouter();
  const [yaml, setYaml] = useState(EXAMPLE_CONFIG);
  const action = useAction();

  async function submit(event: FormEvent) {
    event.preventDefault();
    await action.run(async () => {
      const dot = await api.createDot(yaml);
      router.push(`/dots/${encodeURIComponent(dot.id)}/chat`);
    });
  }

  return (
    <section className="card" aria-labelledby="create-dot">
      <h2 id="create-dot">Create a Dot</h2>
      <form onSubmit={submit}>
        <label htmlFor="dot-config">Configuration (YAML)</label>
        <p className="hint" id="dot-config-hint">
          The server validates the configuration and creates the Dot&apos;s computer. Creating a computer can take a few minutes.
        </p>
        <textarea
          id="dot-config"
          className="code"
          rows={24}
          spellCheck={false}
          value={yaml}
          aria-describedby="dot-config-hint"
          onChange={(e) => setYaml(e.target.value)}
        />
        <ErrorBox error={action.error} title="The Dot was not created" />
        <div className="actions">
          <button type="submit" disabled={action.pending || !yaml.trim()}>
            {action.pending ? "Creating..." : "Create Dot"}
          </button>
        </div>
      </form>
    </section>
  );
}
