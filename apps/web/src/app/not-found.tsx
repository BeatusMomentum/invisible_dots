import type { Metadata } from "next";
import Link from "next/link";
import { buttonVariants } from "../components/ui/button";

export const metadata: Metadata = { title: "Not found" };

/** An address with nothing behind it: an old link, a typo, a Dot that was deleted. In the app's own look, with the way back. */
export default function NotFound() {
  return (
    <main id="main" className="flex min-h-dvh items-center justify-center bg-background px-4 text-foreground">
      <div className="max-w-sm space-y-3 text-center">
        <p className="font-mono text-sm text-muted-foreground">404</p>
        <h1 className="text-xl font-semibold tracking-tight">There is nothing at this address</h1>
        <p className="text-sm text-muted-foreground">The link may be old, or what it showed was deleted.</p>
        <Link href="/" className={buttonVariants()}>
          Go to Home
        </Link>
      </div>
    </main>
  );
}
