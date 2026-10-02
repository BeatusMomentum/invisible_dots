"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const LINKS = [
  { href: "/", label: "Dots", active: (path: string) => path === "/" || path.startsWith("/dots") },
  { href: "/approvals", label: "Approvals", active: (path: string) => path.startsWith("/approvals") },
];

export function MainNav() {
  const path = usePathname() ?? "/";
  return (
    <nav aria-label="Main">
      <ul className="nav-list">
        {LINKS.map((link) => (
          <li key={link.href}>
            <Link href={link.href} aria-current={link.active(path) ? "page" : undefined}>
              {link.label}
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  );
}
