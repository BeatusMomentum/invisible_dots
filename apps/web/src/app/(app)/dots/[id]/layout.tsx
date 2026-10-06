import type { ReactNode } from "react";
import { DotShell } from "../../../../components/DotShell";
import { DotEventScope } from "../../../../components/events";

export default async function DotLayout({
  children,
  params,
}: {
  children: ReactNode;
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return (
    <DotEventScope dotId={id}>
      <DotShell dotId={id}>{children}</DotShell>
    </DotEventScope>
  );
}
