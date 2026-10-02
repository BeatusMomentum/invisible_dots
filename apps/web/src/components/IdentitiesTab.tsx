"use client";

import Link from "next/link";
import { useState, type FormEvent } from "react";
import { ApiError, api } from "../lib/api";
import { formatDate, maskProxy } from "../lib/format";
import { useDot } from "./DotShell";
import { useLiveRefresh } from "./events";
import { ErrorBox, StatusBadge, useAction, useResource } from "./ui";

const IDENTITY_EVENTS = [
  "browser.identity.created",
  "browser.identity.deleted",
  "browser.identity.launched",
  "browser.identity.closed",
  "computer.state",
];

/** The identity routes answer 409 `computer_stopped` while the Dot's computer is off (section 9.6). */
export function isComputerStopped(error: unknown): boolean {
  return error instanceof ApiError && error.status === 409 && error.code === "computer_stopped";
}

export function IdentitiesTab() {
  const { dotId } = useDot();
  const identities = useResource(() => api.listIdentities(dotId), `identities:${dotId}`);
  const remove = useAction();
  useLiveRefresh(identities.reload, IDENTITY_EVENTS);
  const stopped = isComputerStopped(identities.error);

  async function onDelete(id: string, name: string) {
    if (!window.confirm(`Delete the browser identity "${name}"? Its profile, cookies and logins are removed.`)) return;
    const ok = await remove.run(() => api.deleteIdentity(dotId, id));
    if (ok) identities.reload();
  }

  if (stopped) {
    return (
      <div className="notice" role="status">
        <h2>Computer stopped</h2>
        <p>
          Browser identities live on the Dot&apos;s computer, which is not running. Start it from the{" "}
          <Link href={`/dots/${encodeURIComponent(dotId)}/computer`}>Computer</Link> tab to list, create or delete
          identities.
        </p>
      </div>
    );
  }

  return (
    <>
      <CreateIdentity dotId={dotId} onCreated={identities.reload} />
      <h2>Browser identities</h2>
      <ErrorBox error={identities.error} title="Could not load browser identities" />
      <ErrorBox error={remove.error} title="The identity was not deleted" />
      {identities.data && identities.data.length === 0 ? <p className="muted">No browser identities yet.</p> : null}
      {identities.data && identities.data.length > 0 ? (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th scope="col">Name</th>
                <th scope="col">Status</th>
                <th scope="col">Created</th>
                <th scope="col">Last used</th>
                <th scope="col">Proxy</th>
                <th scope="col">
                  <span className="visually-hidden">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {identities.data.map((identity) => (
                <tr key={identity.id}>
                  <td>
                    <div>{identity.name}</div>
                    <code className="muted small">{identity.id}</code>
                  </td>
                  <td>
                    <StatusBadge status={identity.status} />
                  </td>
                  <td>{formatDate(identity.createdAt)}</td>
                  <td>{identity.lastUsedAt ? formatDate(identity.lastUsedAt) : <span className="muted">never</span>}</td>
                  <td>{identity.proxy ? <code>{maskProxy(identity.proxy)}</code> : <span className="muted">none</span>}</td>
                  <td>
                    <button
                      type="button"
                      className="danger"
                      disabled={remove.pending}
                      onClick={() => void onDelete(identity.id, identity.name)}
                    >
                      Delete
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </>
  );
}

function CreateIdentity({ dotId, onCreated }: { dotId: string; onCreated: () => void }) {
  const [name, setName] = useState("");
  const [proxy, setProxy] = useState("");
  const action = useAction();

  async function submit(event: FormEvent) {
    event.preventDefault();
    const ok = await action.run(async () => {
      await api.createIdentity(dotId, proxy.trim() ? { name: name.trim(), proxy: proxy.trim() } : { name: name.trim() });
    });
    if (ok) {
      setName("");
      setProxy("");
      onCreated();
    }
  }

  return (
    <section className="card" aria-labelledby="new-identity">
      <h2 id="new-identity">New browser identity</h2>
      <form onSubmit={submit}>
        <div className="row">
          <div>
            <label htmlFor="identity-name">Name</label>
            <input id="identity-name" type="text" value={name} onChange={(e) => setName(e.target.value)} required />
          </div>
          <div>
            <label htmlFor="identity-proxy">Proxy (optional)</label>
            <input
              id="identity-proxy"
              type="text"
              placeholder="http://user:password@host:port"
              autoComplete="off"
              value={proxy}
              onChange={(e) => setProxy(e.target.value)}
            />
          </div>
        </div>
        <ErrorBox error={isComputerStopped(action.error) ? "The computer is stopped; start it first." : action.error} title="The identity was not created" />
        <div className="actions">
          <button type="submit" disabled={action.pending || !name.trim()}>
            {action.pending ? "Creating..." : "Create identity"}
          </button>
        </div>
      </form>
    </section>
  );
}
