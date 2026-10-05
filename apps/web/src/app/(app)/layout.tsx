import type { ReactNode } from "react";
import { ApiHealth } from "../../components/ApiHealth";
import { MainNav } from "../../components/MainNav";
import { SignOutButton } from "../../components/SignOutButton";

/**
 * Everything behind the session: the header with the navigation, the API
 * check and the sign-out button. The login page lives outside this group on
 * purpose, because it has no session and so nothing here may call the API.
 */
export default function AppLayout({ children }: { children: ReactNode }) {
  return (
    <>
      <header className="site-header">
        <span className="brand">invisible_dots</span>
        <MainNav />
        <span className="header-end">
          <ApiHealth />
          <SignOutButton />
        </span>
      </header>
      <main id="main">{children}</main>
    </>
  );
}
