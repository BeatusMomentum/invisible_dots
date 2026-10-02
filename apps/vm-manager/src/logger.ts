/** A minimal structured logger; the API process passes its own (pino-compatible shape). */
export interface Logger {
  debug(message: string, fields?: Record<string, unknown>): void;
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
}

function write(level: string, message: string, fields?: Record<string, unknown>): void {
  const suffix = fields && Object.keys(fields).length > 0 ? ` ${JSON.stringify(fields)}` : "";
  process.stderr.write(`[vm-manager] ${level} ${message}${suffix}\n`);
}

/** Logs info and above to stderr, one line each. */
export const stderrLogger: Logger = {
  debug: () => {},
  info: (message, fields) => write("info", message, fields),
  warn: (message, fields) => write("warn", message, fields),
  error: (message, fields) => write("error", message, fields),
};

export const silentLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};
