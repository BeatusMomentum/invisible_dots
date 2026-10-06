"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";

const KEY = "idots.chat.panel";

/** The panel is a column beside the chat from this width up, and a sheet over it below. */
export const PANEL_WIDE_PX = 1024;

function isWide(): boolean {
  return window.matchMedia(`(min-width: ${PANEL_WIDE_PX}px)`).matches;
}

interface PanelState {
  /** The computer panel beside the chat is shown. */
  open: boolean;
  setOpen: (open: boolean) => void;
  toggle: () => void;
}

const Context = createContext<PanelState | null>(null);

function stored(): boolean {
  try {
    return window.localStorage.getItem(KEY) === "open";
  } catch {
    return false;
  }
}

/**
 * Whether the computer panel of the chat is open, for the Dot header's button and the chat that draws it. On a wide
 * window the choice is a per-viewer convenience kept in this browser; on a narrow one the panel is a sheet over the
 * chat, which is never opened by what was chosen on another day, and so is not remembered. The first render is
 * always closed so that the server's page and the browser's agree, and the stored choice is applied right after.
 */
export function PanelProvider({ children }: { children: ReactNode }) {
  const [open, setOpenState] = useState(false);
  useEffect(() => setOpenState(isWide() && stored()), []);
  const setOpen = useCallback((next: boolean) => {
    setOpenState(next);
    if (!isWide()) return;
    try {
      window.localStorage.setItem(KEY, next ? "open" : "closed");
    } catch {
      // Storage is blocked: the panel simply forgets the choice on reload.
    }
  }, []);
  const toggle = useCallback(() => setOpen(!open), [open, setOpen]);
  const value = useMemo<PanelState>(() => ({ open, setOpen, toggle }), [open, setOpen, toggle]);
  return <Context.Provider value={value}>{children}</Context.Provider>;
}

export function usePanel(): PanelState {
  const value = useContext(Context);
  if (!value) throw new Error("usePanel must be used inside PanelProvider");
  return value;
}
