"""A Harbor agent that is a Dot doing a task: the instruction goes to the Dot as a task, through the API.

    harbor run -e dots_harbor.environment:DotEnvironment -a dots_harbor.agent:DotAgent ...

The Dot works in its own computer with its own tools, as it does for a person; Harbor's verifier then
grades what it left. The task's paths are moved under /home/dot/bench (paths.py), in the instruction too,
and the Dot is told where it works.
"""

from __future__ import annotations

import json

from harbor.agents.base import BaseAgent
from harbor.environments.base import BaseEnvironment
from harbor.models.agent.context import AgentContext

from . import bridge
from .environment import DotEnvironment
from .paths import map_paths


class DotAgent(BaseAgent):
    @staticmethod
    def name() -> str:
        return "invisible-dots"

    def version(self) -> str | None:
        return None

    async def setup(self, environment: BaseEnvironment) -> None:
        if not isinstance(environment, DotEnvironment):
            raise TypeError("the Dot agent works only in a Dot environment (dots_harbor.environment:DotEnvironment)")

    async def run(self, instruction: str, environment: BaseEnvironment, context: AgentContext) -> None:
        assert isinstance(environment, DotEnvironment) and environment.dot_id is not None
        description = f"{map_paths(instruction)}\n\n(Work in {environment.workdir_path()} on your computer.)"
        # Harbor bounds the run with the task's agent timeout; the bridge cancels the task if it outlives it.
        task = await bridge.call("task", environment.dot_id, str(4 * 3600 * 1000), stdin=description.encode())
        # What the Dot did (its calls, its progress, its answer), kept before the Dot is deleted.
        events = await bridge.call("events", environment.dot_id, task["id"])
        (self.logs_dir / "events.json").write_text(json.dumps(events, indent=1), encoding="utf-8")
        context.cost_usd = task.get("spent_usd")
        context.metadata = {
            "task_id": task.get("id"),
            "status": task.get("status"),
            "summary": task.get("summary"),
            "error": task.get("error"),
        }
