// Derived from shadcn/ui apps/v4/registry/new-york-v4/lib/utils.ts at 0e3abd65, MIT; changed: written out, since the registry file re-exports it from a placeholder module.
import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

/** Class names joined, with the Tailwind utility that comes last winning over the ones it conflicts with. */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
