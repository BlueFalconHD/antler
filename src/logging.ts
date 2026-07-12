export type LogLevel = "debug" | "info" | "warn" | "error";
export type LogFormat = "pretty" | "plain" | "json";

const priorities: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

const secretKey = /password|cookie|authorization|secret|token|content|signedData/i;

function safeFields(fields: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(fields).map(([key, value]) => [
      key,
      secretKey.test(key) ? "[REDACTED]" : value instanceof Error ? value.message : value,
    ]),
  );
}

export class Logger {
  private readonly format: LogFormat;
  private readonly color: boolean;

  public constructor(
    private readonly minimumLevel: LogLevel = "info",
    options: { readonly format?: LogFormat; readonly color?: boolean } = {},
  ) {
    this.format = options.format ?? (process.stderr.isTTY ? "pretty" : "plain");
    this.color = this.format === "pretty" && (options.color ?? !process.env.NO_COLOR);
  }

  public debug(message: string, fields: Record<string, unknown> = {}): void {
    this.write("debug", message, fields);
  }

  public info(message: string, fields: Record<string, unknown> = {}): void {
    this.write("info", message, fields);
  }

  public success(message: string, fields: Record<string, unknown> = {}): void {
    this.write("info", message, fields, "success");
  }

  public warn(message: string, fields: Record<string, unknown> = {}): void {
    this.write("warn", message, fields);
  }

  public error(message: string, fields: Record<string, unknown> = {}): void {
    this.write("error", message, fields);
  }

  private write(
    level: LogLevel,
    message: string,
    fields: Record<string, unknown>,
    style?: "success",
  ): void {
    if (priorities[level] < priorities[this.minimumLevel]) {
      return;
    }
    const safe = safeFields(fields);
    const record = { timestamp: new Date().toISOString(), level, message, ...safe };
    if (this.format === "json") {
      process.stderr.write(`${JSON.stringify(record)}\n`);
      return;
    }
    const symbol = style === "success" ? "✓" : level === "warn" ? "⚠" : level === "error" ? "✗" : level === "debug" ? "·" : "•";
    const coloredSymbol = this.color
      ? `${style === "success" ? "\u001b[32m" : level === "warn" ? "\u001b[33m" : level === "error" ? "\u001b[31m" : "\u001b[36m"}${symbol}\u001b[0m`
      : symbol;
    const details = Object.keys(safe).length > 0
      ? `  ${Object.entries(safe).map(([key, value]) => `${key}=${formatValue(value)}`).join("  ")}`
      : "";
    const timestamp = this.format === "plain" ? `${record.timestamp} ` : "";
    process.stderr.write(`${timestamp}${coloredSymbol} ${message}${details}\n`);
  }
}

function formatValue(value: unknown): string {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Number.isInteger(value) ? String(value) : value.toFixed(1);
  }
  if (typeof value === "string") {
    return /\s/.test(value) ? JSON.stringify(value) : value;
  }
  return JSON.stringify(value);
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}
