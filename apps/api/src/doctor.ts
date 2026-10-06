/**
 * The doctor rows only the control plane's side can read: the images a Dot
 * would get now. The rest of the report is the vm-manager's `runDoctor`
 * (architecture section 11.1); `startServer` serves it as `GET /api/doctor`
 * and `invisible-dots doctor` runs it from the command line, both over this
 * one function.
 */
import { basename } from "node:path";
import { verifyImage } from "@invisible-dots/image-builder";
import type { DoctorCheck, HostPaths } from "@invisible-dots/shared";
import { latestImage } from "./vm-driver.js";

/** The image a Dot would get now (the newest one, as the control plane picks it), checked against its manifest. */
async function imageCheck(paths: HostPaths, id: "golden-image" | "runtime-image"): Promise<DoctorCheck> {
  const golden = id === "golden-image";
  const label = golden ? "golden image" : "runtime ISO";
  let image: string;
  try {
    image = await latestImage(paths.imagesDir, golden ? "golden" : "runtime");
  } catch {
    return { id, label, status: "missing", detail: `none in ${paths.imagesDir}`, fix: "invisible-dots image build" };
  }
  const verdict = await verifyImage(image);
  if (verdict.ok) return { id, label, status: "ok", detail: `${basename(image)} matches its manifest` };
  return { id, label, status: "failed", detail: verdict.reason, fix: verdict.fix };
}

export async function imageChecks(paths: HostPaths): Promise<DoctorCheck[]> {
  return [await imageCheck(paths, "golden-image"), await imageCheck(paths, "runtime-image")];
}
