"use client";

import { MenuIcon } from "lucide-react";
import { usePathname } from "next/navigation";
import { useEffect, useState, type ReactNode } from "react";
import { Button } from "../ui/button";
import { Sheet, SheetContent, SheetDescription, SheetTitle, SheetTrigger } from "../ui/sheet";
import { Rail } from "./Rail";

/**
 * The frame of every signed-in page: the rail beside the page from 768 px up, and below that a bar with a menu
 * button that opens the same rail as a sheet.
 */
export function AppShell({ children }: { children: ReactNode }) {
  const path = usePathname();
  const [open, setOpen] = useState(false);
  // A page change closes the sheet, whatever caused it.
  useEffect(() => setOpen(false), [path]);

  return (
    <div className="min-h-dvh md:grid md:grid-cols-[15.5rem_minmax(0,1fr)]">
      <aside aria-label="Navigation" className="sticky top-0 hidden h-dvh border-r bg-card md:block">
        <Rail />
      </aside>
      <div className="min-w-0">
        <header className="sticky top-0 z-30 flex items-center gap-2 border-b bg-background px-4 py-2 md:hidden">
          <Sheet open={open} onOpenChange={setOpen}>
            <SheetTrigger asChild>
              <Button type="button" variant="ghost" size="icon" aria-label="Open the menu">
                <MenuIcon />
              </Button>
            </SheetTrigger>
            <SheetContent side="left" className="w-72 bg-card p-0">
              <SheetTitle className="sr-only">Menu</SheetTitle>
              <SheetDescription className="sr-only">Pages, Dots and settings</SheetDescription>
              <Rail onNavigate={() => setOpen(false)} />
            </SheetContent>
          </Sheet>
          <span className="font-semibold tracking-tight">invisible_dots</span>
        </header>
        <main id="main" className="mx-auto w-full max-w-[1200px] px-4 py-6 md:px-8">
          {children}
        </main>
      </div>
    </div>
  );
}
