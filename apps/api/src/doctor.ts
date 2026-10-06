/**
 * The doctor rows only the control plane's side can read: the images a Dot
 * would get now. The rest of the report is the vm-manager's `runDoctor`
 * (architecture section 11.1); `startServer` serves it as `GET /api/doctor`
 * and `invisible-dots doctor` runs it from the command line, both over this
 * one function.
 */
import { stat } from "node:fs/promises";
import { basename } from "node:path";
import { manifestPathFor, verifyImage, type ImageCheck } from "@invisible-dots/image-builder";
import type { DoctorCheck, HostPaths } from "@invisible-dots/shared";
import { latestImage } from "./vm-driver.js";

/** The size and modification time of a file, or "absent": what a verdict on it depends on. */
async function fingerprint(path: string): Promise<string> {
  const info = await stat(path).catch(() => undefined);
  return info ? `${info.size}:${info.mtimeMs}` : "absent";
}

/**
 * The doctor's image rows for one host. `verifyImage` re-hashes a whole
 * multi-GB image, and the onboarding checklist asks again and again, so a
 * verdict is kept for as long as the image and its manifest keep the same
 * size and modification time: the hash reruns only when a file changes. The
 * command line runs it once per command and loses nothing.
 */
export function createImageChecks(paths: HostPaths, verify: (image: string) => Promise<ImageCheck> = verifyImage): () => Promise<DoctorCheck[]> {
  const verdicts = new Map<string, { fingerprint: string; check: ImageCheck }>();

  async function verified(image: string): Promise<ImageCheck> {
    const current = `${await fingerprint(image)}|${await fingerprint(manifestPathFor(image))}`;
    const known = verdicts.get(image);
    if (known?.fingerprint === current) return known.check;
    const check = await verify(image);
    verdicts.set(image, { fingerprint: current, check });
    return check;
  }

  /** The image a Dot would get now (the newest one, as the control plane picks it), checked against its manifest. */
  async function imageCheck(id: "golden-image" | "runtime-image"): Promise<DoctorCheck> {
    const golden = id === "golden-image";
    const label = golden ? "golden image" : "runtime ISO";
    let image: string;
    try {
      image = await latestImage(paths.imagesDir, golden ? "golden" : "runtime");
    } catch {
      return { id, label, status: "missing", detail: `none in ${paths.imagesDir}`, fix: "invisible-dots image build" };
    }
    const verdict = await verified(image);
    if (verdict.ok) return { id, label, status: "ok", detail: `${basename(image)} matches its manifest` };
    return { id, label, status: "failed", detail: verdict.reason, fix: verdict.fix };
  }

  return async () => [await imageCheck("golden-image"), await imageCheck("runtime-image")];
}
