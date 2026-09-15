/**
 * Structured JSON logging.
 *
 * One object per line, ids and counts only. Tokens and memory bodies never reach a
 * log line: a leaked log is a leaked memory, and the whole product is built on the
 * promise that it will not happen.
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export type LogFields = Record<string, unknown>;

export interface Logger {
  debug(message: string, fields?: LogFields): void;
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields): void;
  child(fields: LogFields): Logger;
}

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

/**
 * Keys whose values are never printed, whatever the caller thinks it is doing. The
 * list is matched case-insensitively against the key name.
 */
const REDACTED_KEYS = new Set([
  'authorization',
  'token',
  'accesstoken',
  'refreshtoken',
  'idtoken',
  'invitetoken',
  'undotoken',
  'password',
  'secret',
  'clientsecret',
  'apikey',
  // The one-time sign-in code. Last line of defence rather than the fix: production does
  // not select the log sender at all (`RefusingCodeSender`) and the log sender itself does
  // not print the code there (`LogCodeSender`). This is what makes a *fourth* mistake —
  // some future line that logs a code by accident — cost nothing. It is safe to redact
  // unconditionally because nothing else in this codebase logs a field called `code`:
  // error codes travel as `error.code` inside a serialised error, not as a top-level field.
  'code',
  'body',
  'text',
  'query',
  'q',
  'destination',
  'email',
  'phone',
]);

export interface LoggerOptions {
  level?: LogLevel;
  base?: LogFields;
  /** Injected in tests; defaults to stdout. */
  write?: (line: string) => void;
  now?: () => Date;
}

export function createLogger(options: LoggerOptions = {}): Logger {
  const level = options.level ?? 'info';
  const base = options.base ?? {};
  const write = options.write ?? ((line: string) => process.stdout.write(`${line}\n`));
  const now = options.now ?? (() => new Date());

  function emit(logLevel: LogLevel, message: string, fields?: LogFields): void {
    if (LEVEL_ORDER[logLevel] < LEVEL_ORDER[level]) return;
    const line = {
      ts: now().toISOString(),
      level: logLevel,
      msg: message,
      ...redact(base),
      ...redact(fields ?? {}),
    };
    write(safeStringify(line));
  }

  return {
    debug: (message, fields) => emit('debug', message, fields),
    info: (message, fields) => emit('info', message, fields),
    warn: (message, fields) => emit('warn', message, fields),
    error: (message, fields) => emit('error', message, fields),
    child: (fields) => createLogger({ ...options, level, base: { ...base, ...fields } }),
  };
}

export function redact(fields: LogFields): LogFields {
  const out: LogFields = {};
  for (const [key, value] of Object.entries(fields)) {
    out[key] = REDACTED_KEYS.has(key.toLowerCase()) ? '[redacted]' : value;
  }
  return out;
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value, (_key, inner) => (inner instanceof Error ? inner.message : inner));
  } catch {
    return JSON.stringify({ level: 'error', msg: 'log_serialisation_failed' });
  }
}

/** Swallows everything. Handy for tests that do not assert on logging. */
export function silentLogger(): Logger {
  const noop = (): void => {};
  const logger: Logger = {
    debug: noop,
    info: noop,
    warn: noop,
    error: noop,
    child: () => logger,
  };
  return logger;
}
