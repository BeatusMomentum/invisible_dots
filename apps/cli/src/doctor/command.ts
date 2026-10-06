/** `invisible-dots doctor`: the report on stdout, exit code 0 only when every check is ok (section 11.1). */
import { EXIT } from "../exit.js";
import { allOk, doctorAnswer, runDoctor, type DoctorDeps } from "@invisible-dots/vm-manager";
import { renderReport } from "./render.js";

export async function doctorCommand(deps: DoctorDeps, options: { json: boolean }, out: (text: string) => void): Promise<number> {
  const results = await runDoctor(deps);
  out(options.json ? `${JSON.stringify(doctorAnswer(results), null, 2)}\n` : renderReport(results));
  return allOk(results) ? EXIT.ok : EXIT.failed;
}
