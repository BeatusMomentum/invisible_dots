"use client";

import { useState } from "react";
import { signOut } from "../lib/session";

/** Ends the session of this browser and returns to the login page. */
export function SignOutButton() {
  const [state, setState] = useState<{ pending: boolean; error: string | null }>({ pending: false, error: null });

  async function onClick() {
    setState({ pending: true, error: null });
    try {
      await signOut((url) => window.location.assign(url));
    } catch (failure) {
      setState({ pending: false, error: (failure as Error).message });
    }
  }

  return (
    <>
      <button type="button" className="secondary" onClick={onClick} disabled={state.pending}>
        {state.pending ? "Signing out..." : "Sign out"}
      </button>
      {state.error ? (
        <span className="tone-error" role="alert">
          {state.error}
        </span>
      ) : null}
    </>
  );
}
