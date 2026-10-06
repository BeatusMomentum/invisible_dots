-- The events of one task (`GET /api/dots/:id/events?task_id=`): the task drawer lists a task's progress, tool
-- calls and approvals. Which task an event belongs to is `data->>'task_id'`, the one place the contract puts it,
-- so the index is on that expression; events with no task (a chat turn's) stay out of it.
CREATE INDEX events_task_idx ON events (dot_id, (data->>'task_id'), id) WHERE data->>'task_id' IS NOT NULL;
