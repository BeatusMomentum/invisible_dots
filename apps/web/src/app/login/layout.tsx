import type { ReactNode } from "react";

/** The login page has no rail and no API calls: the person has no session yet. */
export default function LoginLayout({ children }: { children: ReactNode }) {
  return (
    <main id="main" className="grid min-h-dvh place-items-center px-4 py-12">
      {children}
    </main>
  );
}
