// Derived from OpenDots (CopilotKit) src/client/ComputerToolCard.tsx at 88f2a08, MIT; changed: the map is over this engine's tool table (permissions.py) and not the demo's computer actions; each entry says in past tense what the call did and which family of tools it belongs to; a tool the table does not know is named as the model called it.

/** What kind of thing a tool does: the chat draws one icon per family. */
export type ToolFamily = "command" | "read" | "write" | "memory" | "automation" | "screen" | "browser-identity" | "browser" | "other";

export interface ToolLabel {
  /** What the call did, as a short phrase: "Ran a command". */
  label: string;
  family: ToolFamily;
}

/**
 * The words for every tool of the engine's table (`nanobot/dots/permissions.py` `TOOL_PERMISSIONS`); a test reads that
 * file and fails when a tool is missing here or a name here is no longer a tool, so the two cannot drift.
 */
export const TOOL_LABELS: Readonly<Record<string, ToolLabel>> = {
  exec: { label: "Ran a command", family: "command" },
  exec_session: { label: "Used a command session", family: "command" },
  list_exec_sessions: { label: "Listed command sessions", family: "command" },
  read_file: { label: "Read a file", family: "read" },
  list_dir: { label: "Listed a folder", family: "read" },
  find_files: { label: "Searched for files", family: "read" },
  grep: { label: "Searched in files", family: "read" },
  write_file: { label: "Wrote a file", family: "write" },
  edit_file: { label: "Edited a file", family: "write" },
  apply_patch: { label: "Applied a patch", family: "write" },
  memory_search: { label: "Searched its memory", family: "memory" },
  memory_get: { label: "Read a memory note", family: "memory" },
  cron: { label: "Managed an automation", family: "automation" },
  computer_screenshot: { label: "Looked at the desktop", family: "screen" },
  browser_identity_list: { label: "Listed browser identities", family: "browser-identity" },
  browser_identity_create: { label: "Created a browser identity", family: "browser-identity" },
  browser_identity_delete: { label: "Deleted a browser identity", family: "browser-identity" },
  browser_identity_launch: { label: "Opened a browser", family: "browser-identity" },
  browser_identity_close: { label: "Closed a browser", family: "browser-identity" },
  browser_navigate: { label: "Opened a page", family: "browser" },
  browser_snapshot: { label: "Inspected the page", family: "browser" },
  browser_read_text: { label: "Read the page", family: "browser" },
  browser_screenshot: { label: "Looked at the page", family: "browser" },
  browser_click: { label: "Clicked on the page", family: "browser" },
  browser_click_at: { label: "Clicked on the page", family: "browser" },
  browser_type: { label: "Typed on the page", family: "browser" },
  browser_press_key: { label: "Pressed a key", family: "browser" },
  browser_select_option: { label: "Chose an option", family: "browser" },
  browser_scroll: { label: "Scrolled the page", family: "browser" },
  browser_back: { label: "Went back", family: "browser" },
  browser_forward: { label: "Went forward", family: "browser" },
  browser_reload: { label: "Reloaded the page", family: "browser" },
};

/** The words for a tool; one the table does not know (the model called a name the engine refuses) keeps its own name. */
export function toolLabel(tool: string): ToolLabel {
  return Object.hasOwn(TOOL_LABELS, tool) ? TOOL_LABELS[tool]! : { label: `Called ${tool}`, family: "other" };
}
