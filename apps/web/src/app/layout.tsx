import type { Metadata, Viewport } from "next";
import { headers } from "next/headers";
import type { ReactNode } from "react";
import { Toaster } from "../components/ui/sonner";
import { THEME_BOOTSTRAP } from "../lib/theme";
import "./globals.css";

export const metadata: Metadata = {
  title: { default: "invisible_dots", template: "%s - invisible_dots" },
  description: "Control plane for Dots: agents that each own a Linux computer.",
};

export const viewport: Viewport = {
  colorScheme: "light dark",
};

export default async function RootLayout({ children }: { children: ReactNode }) {
  // The nonce the request's Content Security Policy names (src/proxy.ts): the theme script is the one inline script that is ours.
  const nonce = (await headers()).get("x-nonce") ?? undefined;
  return (
    // The theme script sets data-theme before the first paint, so the server's markup has none to agree with.
    <html lang="en" suppressHydrationWarning>
      <head>
        <script nonce={nonce} dangerouslySetInnerHTML={{ __html: THEME_BOOTSTRAP }} />
      </head>
      <body>
        <a
          className="sr-only z-50 rounded-md bg-card px-3 py-2 text-sm focus:not-sr-only focus:fixed focus:top-2 focus:left-2"
          href="#main"
        >
          Skip to content
        </a>
        {children}
        <Toaster />
      </body>
    </html>
  );
}
