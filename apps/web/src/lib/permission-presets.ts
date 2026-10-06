/**
 * The three ways to start a Dot's permissions, one click each: what a person picks when they do not want to go
 * through fourteen rows. A preset is only the overrides it writes into the config's `permissions`; every
 * permission it leaves out keeps the shipped default (`resolvePermission` in the shared package), so a preset can
 * never disagree with the defaults about a permission it does not name.
 */
import { PERMISSIONS, resolvePermission, type Permission, type PermissionDecision } from "@invisible-dots/shared/browser";

export type PermissionMap = Partial<Record<string, PermissionDecision>>;

export const PRESET_IDS = ["careful", "balanced", "autonomous"] as const;
export type PresetId = (typeof PRESET_IDS)[number];

export interface Preset {
  id: PresetId;
  label: string;
  description: string;
  permissions: Readonly<Partial<Record<Permission, PermissionDecision>>>;
}

const AUTONOMOUS = Object.fromEntries(PERMISSIONS.map((permission) => [permission, permission === "browser.identity.delete" ? "ask" : "allow"])) as Record<Permission, PermissionDecision>;

export const PRESETS: Readonly<Record<PresetId, Preset>> = {
  careful: {
    id: "careful",
    label: "Careful",
    description: "Asks you before it runs a command or changes a file.",
    permissions: { "files.write": "ask", "computer.exec": "ask" },
  },
  balanced: {
    id: "balanced",
    label: "Balanced",
    description: "The defaults: works freely on its own computer, and asks before it deletes a browser identity or adds an automation.",
    permissions: {},
  },
  autonomous: {
    id: "autonomous",
    label: "Autonomous",
    description: "Never asks, except before it deletes a browser identity.",
    permissions: AUTONOMOUS,
  },
};

/** The permissions a preset writes into a config: a copy, so nobody edits the preset by accident. */
export function presetPermissions(id: PresetId): Record<string, PermissionDecision> {
  return { ...PRESETS[id].permissions } as Record<string, PermissionDecision>;
}

function decisions(permissions: PermissionMap): PermissionDecision[] {
  return PERMISSIONS.map((permission) => resolvePermission({ permissions: permissions as Record<string, PermissionDecision> }, permission));
}

/**
 * The preset a config's permissions amount to, or null when they are something else (set in YAML or by hand).
 * Compared by what each permission resolves to, so an explicit `allow` where the default is `allow` still counts.
 */
export function presetOf(permissions: PermissionMap): PresetId | null {
  const mine = decisions(permissions);
  return PRESET_IDS.find((id) => decisions(PRESETS[id].permissions).every((decision, i) => decision === mine[i])) ?? null;
}
