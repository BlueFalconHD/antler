export type LogLevel = "debug" | "info" | "warn" | "error";

const priorities: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

const secretKey = /password|cookie|authorization|secret|token|content|data/i;

function safeFields(fields: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(fields).map(([key, value]) => [
      key,
      secretKey.test(key) ? "[REDACTED]" : value instanceof Error ? value.message : value,
    ]),
  );
}

export class Logger {
  public constructor(private readonly minimumLevel: LogLevel = "info") {}

  public debug(message: string, fields: Record<string, unknown> = {}): void {
    this.write("debug", message, fields);
  }

  public info(message: string, fields: Record<string, unknown> = {}): void {
    this.write("info", message, fields);
  }

  public warn(message: string, fields: Record<string, unknown> = {}): void {
    this.write("warn", message, fields);
  }

  public error(message: string, fields: Record<string, unknown> = {}): void {
    this.write("error", message, fields);
  }

  private write(level: LogLevel, message: string, fields: Record<string, unknown>): void {
    if (priorities[level] < priorities[this.minimumLevel]) {
      return;
    }
    const record = { timestamp: new Date().toISOString(), level, message, ...safeFields(fields) };
    process.stderr.write(`${JSON.stringify(record)}\n`);
  }
}
