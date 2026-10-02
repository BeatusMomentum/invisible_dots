import type { ReactNode } from "react";
import { DotShell } from "../../../components/DotShell";
import { EventStreamProvider } from "../../../components/events";

export default async function DotLayout({
  children,
  params,
}: {
  children: ReactNode;
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return (
    <EventStreamProvider dotId={id}>
      <DotShell dotId={id}>{children}</DotShell>
    </EventStreamProvider>
  );
}
