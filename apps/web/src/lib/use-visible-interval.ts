"use client";
// Derived from OpenDots (CopilotKit) src/client/ComputerPanel.tsx at 88f2a08, MIT; changed: a hook over any async function and any period, not the demo's computer polling; a tick that is still running is waited for, a hidden page is skipped and a page that becomes visible again polls at once.

import { useEffect, useRef } from "react";

/**
 * Call `tick` now and then every `intervalMs` while `enabled`, but never while the page is hidden (a tab nobody
 * looks at asks nothing of the control plane) and never two at a time: the next one is scheduled when the last
 * has finished. Showing the page again polls at once, so the person never waits a whole period for a fresh view.
 */
export function useVisibleInterval(tick: () => void | Promise<void>, intervalMs: number, enabled: boolean): void {
  const latest = useRef(tick);
  useEffect(() => {
    latest.current = tick;
  });

  useEffect(() => {
    if (!enabled) return;
    let stopped = false;
    let running = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const schedule = () => {
      if (!stopped) timer = setTimeout(() => void poll(), intervalMs);
    };
    const poll = async () => {
      if (stopped || running) return;
      if (document.hidden) {
        schedule();
        return;
      }
      running = true;
      try {
        await latest.current();
      } catch {
        // The caller reports its own failures; the loop only keeps time.
      } finally {
        running = false;
      }
      schedule();
    };
    const onVisible = () => {
      if (document.hidden || running) return;
      clearTimeout(timer);
      void poll();
    };

    void poll();
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      stopped = true;
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [intervalMs, enabled]);
}
