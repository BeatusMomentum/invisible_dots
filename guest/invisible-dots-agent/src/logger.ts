/**
 * One JSON object per line on stdout, which journald stores as is and
 * `journalctl -o cat` prints readably. Field values are never secrets: the
 * code that holds the OpenRouter key does not pass it to a logger.
 */
import type { Logger } from "@invisible-dots/agent-runtime";

export type LogLevel = "debug" | "info" | "warn" | "error";
const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export function isLogLevel(value: unknown): value is LogLevel {
  return typeof value === "string" && value in ORDER;
}

export function createJsonLogger(
  options: { level?: LogLevel; write?: (line: string) => void; component?: string; now?: () => Date } = {},
): Logger {
  const min = ORDER[options.level ?? "info"];
  const write = options.write ?? ((line: string) => process.stdout.write(line));
  const now = options.now ?? (() => new Date());
  const emit = (level: LogLevel, message: string, fields?: Record<string, unknown>) => {
    if (ORDER[level] < min) return;
    const record: Record<string, unknown> = { ts: now().toISOString(), level, msg: message };
    if (options.component) record.component = options.component;
    if (fields) {
      for (const [key, value] of Object.entries(fields)) {
        if (value !== undefined && !(key in record)) record[key] = value;
      }
    }
    write(`${JSON.stringify(record)}\n`);
  };
  return {
    debug: (m, f) => emit("debug", m, f),
    info: (m, f) => emit("info", m, f),
    warn: (m, f) => emit("warn", m, f),
    error: (m, f) => emit("error", m, f),
  };
}
