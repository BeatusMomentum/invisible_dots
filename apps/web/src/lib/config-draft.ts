/**
 * The config a person is editing, and what it is edited from. `base` is the config as the host had it when the edit
 * began, with its `version` (`config_version`), which a save sends so that a config changed meanwhile is refused and
 * never undone. When the host's config moves on under an edit that is under way (another tab, an "Always allow"),
 * the edits are put on top of the new one (`rebase`) and the page says so, so the review before the save shows
 * the person what they are about to write over what is now there.
 */
import type { DotConfig } from "@invisible-dots/shared/browser";
import { configChanges, rebase } from "./config-fields";

export interface DraftState {
  base: DotConfig;
  version: number;
  draft: DotConfig;
  /** The host's config changed under edits that were under way, and the edits were put on top of the new one. */
  rebased: boolean;
}

export function startDraft(config: DotConfig, version: number): DraftState {
  return { base: config, version, draft: config, rebased: false };
}

/** The draft changed by the person. */
export function edit(state: DraftState, draft: DotConfig): DraftState {
  return { ...state, draft };
}

/** Back to what the host has. */
export function discard(state: DraftState): DraftState {
  return startDraft(state.base, state.version);
}

/**
 * The host's config as it is now. The same version changes nothing, and neither does an older one (an answer that
 * was slow to arrive: the config only ever moves forward); a newer one replaces the base, with any edits kept on top.
 */
export function follow(state: DraftState, config: DotConfig, version: number): DraftState {
  if (version <= state.version) return state;
  if (configChanges(state.base, state.draft).length === 0) return startDraft(config, version);
  return { base: config, version, draft: rebase(state.base, state.draft, config), rebased: true };
}
