import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import { ApiHealth } from "../components/ApiHealth";
import { MainNav } from "../components/MainNav";
import "./globals.css";

export const metadata: Metadata = {
  title: { default: "invisible_dots", template: "%s - invisible_dots" },
  description: "Control plane for Dots: agents that each own a Linux computer.",
};

export const viewport: Viewport = {
  colorScheme: "light dark",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <a className="skip-link" href="#main">
          Skip to content
        </a>
        <header className="site-header">
          <span className="brand">invisible_dots</span>
          <MainNav />
          <ApiHealth />
        </header>
        <main id="main">{children}</main>
      </body>
    </html>
  );
}
