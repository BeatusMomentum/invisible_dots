/** The doctor report as text: one line per check, a fix line under each that is not ok, and a count. */
import type { CheckResult } from "./checks.js";

const STATUS_WIDTH = "missing".length + 2;

export function renderReport(results: readonly CheckResult[]): string {
  const labelWidth = Math.max(...results.map((r) => r.label.length)) + 2;
  const indent = " ".repeat(STATUS_WIDTH + labelWidth);
  const lines: string[] = [];
  for (const r of results) {
    lines.push(`${r.status.padEnd(STATUS_WIDTH)}${r.label.padEnd(labelWidth)}${r.detail}`);
    if (r.status !== "ok" && r.fix) lines.push(`${indent}fix: ${r.fix}`);
  }
  const count = (status: CheckResult["status"]) => results.filter((r) => r.status === status).length;
  const ok = count("ok");
  lines.push(
    ok === results.length
      ? `all ${results.length} checks ok`
      : `${results.length} checks: ${ok} ok, ${count("missing")} missing, ${count("failed")} failed`,
  );
  return `${lines.join("\n")}\n`;
}
