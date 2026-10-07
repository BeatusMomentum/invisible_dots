"use client";

import Link from "next/link";
import { computerIsUp } from "@invisible-dots/shared/browser";
import { api } from "../../lib/api";
import { isComputerStopped } from "../../lib/computer";
import { skillBody, skillsHref, type SkillsQuery } from "../../lib/skills-view";
import { cn } from "../../lib/utils";
import { ComputerOff } from "../computer/computer-off";
import { useDot } from "../DotShell";
import { ErrorAlert } from "../ErrorAlert";
import { useLiveRefresh } from "../events";
import { Markdown } from "../markdown";
import { useResource } from "../ui";
import { Badge } from "../ui/badge";
import { Skeleton } from "../ui/skeleton";

/** A turn that ended may have written a skill of the Dot's own. */
const SKILL_EVENTS = ["task.completed", "task.failed", "message.assistant"];
const NEEDS_THE_COMPUTER = "Start the computer to see its skills";

/**
 * The Skills page: how the Dot does a kind of task, read only. The built-in skills ship with invisible_dots; the Dot
 * writes its own under /home/dot/skills as it learns, and one of its own replaces a built-in one of the same name. The
 * list is the engine's (`GET /skills`), so it reads the Dot's computer: a computer that is not running is said, with
 * Start, as on the Computer page. The open skill is in the address.
 */
export function SkillsView({ query }: { query: SkillsQuery }) {
  const { dotId, dot } = useDot();
  const state = dot.data?.computer_state;
  // The Dot's state is not known yet: nothing is asked of the computer until it is.
  if (state === undefined) return <Skeleton className="h-48 w-full" aria-busy="true" />;
  if (!computerIsUp(state)) return <ComputerOff dotId={dotId} state={state} what={NEEDS_THE_COMPUTER} />;
  return <Skills dotId={dotId} open={query.skill} state={state} />;
}

function Skills({ dotId, open, state }: { dotId: string; open: string | null; state: string | null }) {
  const skills = useResource(() => api.listSkills(dotId), `skills:${dotId}`);
  useLiveRefresh(skills.reload, SKILL_EVENTS);
  if (isComputerStopped(skills.error)) return <ComputerOff dotId={dotId} state={state} what={NEEDS_THE_COMPUTER} />;
  const chosen = skills.data?.find((skill) => skill.name === open) ?? null;

  return (
    <div className="grid min-h-0 flex-1 gap-4 lg:grid-cols-[minmax(0,22rem)_minmax(0,1fr)]">
      <section aria-labelledby="skills-heading" className="min-h-0 space-y-3 overflow-y-auto">
        <div className="space-y-1">
          <h2 id="skills-heading" className="text-sm font-semibold">
            Skills
          </h2>
          <p className="text-xs text-muted-foreground">
            How the Dot does a kind of task. It reads a skill before a task it covers, and writes its own in /home/dot/skills as it learns.
          </p>
        </div>
        <ErrorAlert error={skills.error} title="Could not read the skills" />
        {skills.data === undefined ? (
          skills.error ? null : <Skeleton className="h-32 w-full" aria-busy="true" />
        ) : skills.data.length === 0 ? (
          <p className="text-sm text-muted-foreground">The Dot has no skills.</p>
        ) : (
          <ul aria-label="The Dot's skills" className="divide-y overflow-hidden rounded-lg border bg-card">
            {skills.data.map((skill) => (
              <li key={skill.name}>
                <Link
                  href={skillsHref(dotId, skill.name)}
                  aria-current={skill.name === open ? "page" : undefined}
                  className={cn("block space-y-1 px-3 py-2.5 hover:bg-muted", skill.name === open && "bg-muted")}
                >
                  <span className="flex flex-wrap items-center gap-2">
                    <code className="font-mono text-sm font-medium">{skill.name}</code>
                    <Badge variant="outline">{skill.source === "builtin" ? "Built in" : "Written by the Dot"}</Badge>
                  </span>
                  <span className="block text-xs text-muted-foreground">{skill.description}</span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>
      <section aria-label={chosen ? `The skill ${chosen.name}` : "The skill"} className="min-h-0 overflow-y-auto rounded-lg border bg-card p-4">
        {chosen ? (
          <div className="space-y-3">
            <p className="font-mono text-xs break-all text-muted-foreground">{chosen.path}</p>
            <Markdown>{skillBody(chosen.content)}</Markdown>
          </div>
        ) : open !== null && skills.data !== undefined ? (
          <p className="text-sm text-muted-foreground">The Dot has no skill named {open}.</p>
        ) : (
          <p className="text-sm text-muted-foreground">Pick a skill to read it.</p>
        )}
      </section>
    </div>
  );
}
