import type { ReactNode } from "react";

/** The login page has no header and no API calls: the person has no session yet. */
export default function LoginLayout({ children }: { children: ReactNode }) {
  return <main id="main">{children}</main>;
}
