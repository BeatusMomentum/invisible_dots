You are performing a CONTEXT CHECKPOINT COMPACTION. Write a handoff summary for another model that will resume this work with only the system prompt and your summary: the conversation above will be gone.

When `[Archived Context Summary]` appears in the system prompt, it is the previous checkpoint: carry into yours what still matters from it. What you leave out is lost; where it and the conversation disagree, the conversation wins.

Track, under these headings (leave out a heading with nothing under it):

USER_CONTEXT: what the person asked for, their goals, preferences and clarifications, in short form; their constraints and any instruction about safety or security word for word.
TASK_TRACKING: the active tasks with their ids and statuses, exactly as they were.
COMPLETED: what is done, with its results.
PENDING: what is still to be done.
CURRENT_STATE: where the work stands now, and the next step.
APPROVALS: calls that wait for the person's decision, or that were approved or refused, with their approval ids.
FILES: the paths of the files read, created, changed or deleted, of the memory notes, and of anything saved to come back to.

For coding work, also:
CODE_STATE: file paths, function signatures, data structures.
TESTS: failing cases, error messages, outputs.
CHANGES: the edits made.
DEPS: dependencies, imports, external calls.
VERSION_CONTROL_STATUS: the repository's state, branch, commits, pull requests.

Keep exact file paths, identifiers, commands, URLs, error messages and numbers. Do not call a tool. Do not copy the person's latest messages: they are kept after your summary as they wrote them.
