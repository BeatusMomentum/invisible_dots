-- When the Dot's earliest enabled automation is next due, as its guest last reported it (the `automation.next_run`
-- event, architecture sections 5.4 and 9.5). The guest keeps its automations in its own state and powers off with
-- the computer, so the host keeps this one time to wake a stopped computer shortly before it and to not put a
-- computer to sleep that is about to need it. NULL: none is due, or the guest has reported nothing yet. A time in
-- the past is a run the guest has not made yet (it makes it when it starts).
--
-- A computer that is already stopped when this is applied has reported nothing: its column stays NULL, so it is not
-- woken for its automations until it starts for another reason (a message, a task, the person), and its guest reports
-- its next run at that start. The host does not start every sleeping computer once to ask: that would be a boot of
-- every Dot at every upgrade for the sake of a report most of them do not have.
ALTER TABLE computers ADD COLUMN next_automation_at timestamptz;

-- Why the computer is off or going off while its state is STOPPING or STOPPED (NULL otherwise): the idle sleep, the
-- person's own stop, or a VM that stopped by itself. A computer the person stopped is not started for its
-- automations until the person starts it again; every other stopped computer is. NULL while stopped (a computer
-- stopped before this existed) counts as not stopped by the person.
ALTER TABLE computers ADD COLUMN stop_reason text CHECK (stop_reason IN ('idle', 'user', 'exited'));
