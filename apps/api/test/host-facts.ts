import type { HostFacts } from "@invisible-dots/sdk/types";

/** Where a fake host keeps its state, as `GET /api/health` is to say it. */
export const hostFacts = (kind: HostFacts["database_kind"] = "pglite"): HostFacts => ({
  database_kind: kind,
  data_dir: "/srv/dots-home",
  logs_dir: "/srv/dots-home/logs",
});
