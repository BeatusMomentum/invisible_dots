"use client";

import { LogOutIcon } from "lucide-react";
import { useState } from "react";
import { signOut } from "../../lib/session";
import { Button } from "../ui/button";

/** Ends the session of this browser and returns to the login page; quiet in the rail, an outlined button on the settings page. */
export function SignOutButton({ variant = "ghost" }: { variant?: "ghost" | "outline" }) {
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
      <Button type="button" variant={variant} size="sm" className={variant === "ghost" ? "justify-start text-muted-foreground" : undefined} onClick={onClick} disabled={state.pending}>
        <LogOutIcon />
        {state.pending ? "Signing out..." : "Sign out"}
      </Button>
      {state.error ? (
        <p className="text-xs text-danger" role="alert">
          {state.error}
        </p>
      ) : null}
    </>
  );
}
