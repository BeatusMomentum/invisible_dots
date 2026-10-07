"use client";

import { MenuIcon } from "lucide-react";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Button } from "../ui/button";
import { Sheet, SheetContent, SheetDescription, SheetTitle, SheetTrigger } from "../ui/sheet";
import { OfflineBanner } from "./offline-banner";
import { Rail } from "./Rail";

/**
 * The frame of every page: the rail beside the page from 768 px up, and below that a bar with a menu button that
 * opens the same rail as a sheet. The page takes the whole height of the window and the whole width beside the rail.
 */
export function AppShell({ children }: { children: ReactNode }) {
  const path = usePathname();
  const [open, setOpen] = useState(false);
  const menu = useRef<HTMLDivElement>(null);
  // A page change closes the sheet, whatever caused it.
  useEffect(() => setOpen(false), [path]);

  return (
    <div className="h-dvh md:grid md:grid-cols-[15.5rem_minmax(0,1fr)]">
      <aside aria-label="Navigation" className="sticky top-0 hidden h-dvh border-r bg-card md:block">
        <Rail />
      </aside>
      <div className="flex h-dvh min-w-0 flex-col">
        <header className="sticky top-0 z-30 flex items-center gap-2 border-b bg-background px-4 py-2 md:hidden">
          <Sheet open={open} onOpenChange={setOpen}>
            <SheetTrigger asChild>
              <Button type="button" variant="ghost" size="icon" aria-label="Open the menu">
                <MenuIcon />
              </Button>
            </SheetTrigger>
            <SheetContent
              ref={menu}
              side="left"
              className="w-72 bg-card p-0"
              // The menu opens on the page the person is on. Radix would focus the first control that is not a link,
              // which is a status of the rail's foot, and focus opens its tooltip.
              onOpenAutoFocus={(event) => {
                const page = menu.current?.querySelector<HTMLElement>('nav a[aria-current="page"]') ?? menu.current?.querySelector<HTMLElement>("nav a");
                if (!page) return;
                event.preventDefault();
                page.focus();
              }}
            >
              <SheetTitle className="sr-only">Menu</SheetTitle>
              <SheetDescription className="sr-only">Pages, Dots and settings</SheetDescription>
              <Rail onNavigate={() => setOpen(false)} />
            </SheetContent>
          </Sheet>
          <span className="font-semibold tracking-tight">invisible_dots</span>
        </header>
        <OfflineBanner />
        {/* The page fills the rest of the window and scrolls inside it; a page that fills the window exactly (a Dot's) has nothing to scroll.
            relative: what is positioned inside (screen-reader text, Radix's hidden selects) is contained by this scroller,
            not by the window, or it would make the whole document scroll. */}
        <main id="main" className="relative flex min-h-0 flex-1 flex-col overflow-y-auto px-4 py-5 md:px-8">
          {children}
        </main>
      </div>
    </div>
  );
}
