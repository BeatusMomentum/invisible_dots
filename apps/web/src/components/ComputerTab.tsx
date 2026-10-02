"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { api, computerAction, type ComputerAction } from "../lib/api";
import { allowedActions, computerView, type Usage } from "../lib/computer";
import { formatBytes, formatDate, formatDuration } from "../lib/format";
import { useDot } from "./DotShell";
import { useLiveRefresh } from "./events";
import { ErrorBox, StatusBadge, useAction, useResource } from "./ui";

const COMPUTER_EVENTS = ["computer.state", "computer.started", "computer.stopped"];
const AUTO_REFRESH_MS = 10_000;

function Meter({ label, usage }: { label: string; usage: Usage }) {
  const percent = Math.round(usage.fraction * 100);
  return (
    <div className="meter-row">
      <div className="meter-label">
        <span>{label}</span>
        <span>
          {formatBytes(usage.usedBytes)} of {formatBytes(usage.totalBytes)} used ({percent}%)
        </span>
      </div>
      <meter min={0} max={1} low={0.75} high={0.9} optimum={0} value={usage.fraction} aria-label={`${label} used`}>
        {percent}%
      </meter>
    </div>
  );
}

export function ComputerTab() {
  const { dotId, dot } = useDot();
  const computer = useResource(() => api.computer(dotId), `computer:${dotId}`);
  const power = useAction();
  useLiveRefresh(() => {
    computer.reload();
    dot.reload();
  }, COMPUTER_EVENTS);

  const view = computerView(computer.data ?? null, dot.data?.config ?? null);
  const allowed = allowedActions(view.state);
  const running = view.state === "RUNNING" || view.state === "IDLE";

  async function act(action: ComputerAction) {
    if (action !== "start" && !window.confirm(`${action === "stop" ? "Stop" : "Reboot"} this Dot's computer?`)) return;
    const ok = await power.run(() => computerAction(api, dotId, action));
    if (ok) computer.reload();
  }

  return (
    <>
      <div className="toolbar">
        <h2>Computer</h2>
        <StatusBadge status={view.state} label="Computer state" />
        <button type="button" className="secondary" onClick={computer.reload} disabled={computer.loading}>
          Refresh
        </button>
      </div>
      <ErrorBox error={computer.error} title="Could not load the computer" />
      <div className="actions">
        <button type="button" disabled={power.pending || !allowed.start} onClick={() => void act("start")}>
          Start
        </button>
        <button type="button" className="secondary" disabled={power.pending || !allowed.reboot} onClick={() => void act("reboot")}>
          Reboot
        </button>
        <button type="button" className="danger" disabled={power.pending || !allowed.stop} onClick={() => void act("stop")}>
          Stop
        </button>
      </div>
      <ErrorBox error={power.error} title="The action failed" />

      <div className="grid-2">
        <section className="card" aria-labelledby="allocated">
          <h3 id="allocated">Allocated</h3>
          <dl className="facts">
            <dt>vCPUs</dt>
            <dd>{view.allocated.cpus ?? "-"}</dd>
            <dt>Memory</dt>
            <dd>{view.allocated.memory ?? "-"}</dd>
            <dt>Disk</dt>
            <dd>{view.allocated.disk ?? "-"}</dd>
            <dt>Sleeps after idle</dt>
            <dd>{view.allocated.idleTimeout && /^0+[a-z]*$/.test(view.allocated.idleTimeout) ? "never" : (view.allocated.idleTimeout ?? "-")}</dd>
            {computer.data?.last_active_at ? (
              <>
                <dt>Last active</dt>
                <dd>{formatDate(computer.data.last_active_at)}</dd>
              </>
            ) : null}
            {computer.data?.golden_image ? (
              <>
                <dt>Golden image</dt>
                <dd>
                  <code>{computer.data.golden_image}</code>
                </dd>
              </>
            ) : null}
          </dl>
        </section>
        <section className="card" aria-labelledby="live">
          <h3 id="live">Live usage</h3>
          {view.live ? (
            <>
              <dl className="facts">
                <dt>Hostname</dt>
                <dd>{view.live.hostname || "-"}</dd>
                <dt>Uptime</dt>
                <dd>{formatDuration(view.live.uptimeSeconds)}</dd>
                <dt>CPUs</dt>
                <dd>{view.live.cpus}</dd>
              </dl>
              <Meter label="Memory" usage={view.live.memory} />
              <Meter label="Disk" usage={view.live.disk} />
            </>
          ) : (
            <p className="muted">
              {running ? "The computer did not report its usage." : "Live usage is shown while the computer runs."}
            </p>
          )}
        </section>
      </div>
      <Screenshot dotId={dotId} running={running} />
    </>
  );
}

function Screenshot({ dotId, running }: { dotId: string; running: boolean }) {
  const [url, setUrl] = useState<string | null>(null);
  const [takenAt, setTakenAt] = useState<string | null>(null);
  const [auto, setAuto] = useState(false);
  const shot = useAction();
  const current = useRef<string | null>(null);

  const load = useCallback(async () => {
    await shot.run(async () => {
      const blob = new Blob([await api.screenshot(dotId)], { type: "image/png" });
      const next = URL.createObjectURL(blob);
      if (current.current) URL.revokeObjectURL(current.current);
      current.current = next;
      setUrl(next);
      setTakenAt(new Date().toISOString());
    });
  }, [dotId, shot.run]);

  useEffect(() => {
    if (running) void load();
  }, [running, load]);

  useEffect(() => {
    if (!auto || !running) return;
    const timer = setInterval(() => void load(), AUTO_REFRESH_MS);
    return () => clearInterval(timer);
  }, [auto, running, load]);

  useEffect(
    () => () => {
      if (current.current) URL.revokeObjectURL(current.current);
    },
    [],
  );

  return (
    <section className="card" aria-labelledby="screenshot">
      <div className="toolbar">
        <h3 id="screenshot">Screen</h3>
        <button type="button" className="secondary" disabled={shot.pending} onClick={() => void load()}>
          {shot.pending ? "Loading..." : "Take screenshot"}
        </button>
        <label className="inline">
          <input type="checkbox" checked={auto} onChange={(e) => setAuto(e.target.checked)} /> Refresh every 10 s
        </label>
      </div>
      <ErrorBox error={shot.error} title="No screenshot" />
      {url ? (
        <figure className="screenshot">
          {/* A plain img: the source is a blob URL of the PNG the API returned, which next/image cannot load. */}
          <img src={url} alt="The Dot's desktop, display :0" />
          {takenAt ? <figcaption className="muted small">Taken {formatDate(takenAt)}</figcaption> : null}
        </figure>
      ) : !running ? (
        <p className="muted">The computer is not running.</p>
      ) : null}
    </section>
  );
}
