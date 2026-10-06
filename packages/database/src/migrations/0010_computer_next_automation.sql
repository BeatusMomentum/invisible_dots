-- When the Dot's earliest enabled automation is next due, as its guest last reported it (the `automation.next_run`
-- event, architecture sections 5.4 and 9.5). The guest keeps its automations in its own state and powers off with
-- the computer, so the host keeps this one time to wake a stopped computer shortly before it and to not put a
-- computer to sleep that is about to need it. NULL: none is due, or the guest has reported nothing yet. A time in
-- the past is a run the guest has not made yet (it makes it when it starts).
ALTER TABLE computers ADD COLUMN next_automation_at timestamptz;
