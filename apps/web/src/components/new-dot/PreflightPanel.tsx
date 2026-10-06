"use client";

import { CheckAgainButton, CheckList, CheckListSkeleton } from "../setup/CheckList";
import { Section } from "../setup/Section";
import { useHostChecks } from "../setup/use-host-checks";

/** What a new Dot depends on, checked when the page opens and again on request. It informs; creating stays possible. */
export function PreflightPanel() {
  const checks = useHostChecks();
  return (
    <Section id="preflight" title="Before you create" busy={checks.loading} action={<CheckAgainButton onClick={checks.reload} loading={checks.loading} />}>
      {checks.items === null ? <CheckListSkeleton /> : <CheckList items={checks.items} />}
    </Section>
  );
}
