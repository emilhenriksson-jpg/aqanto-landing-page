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
  /**
   * The one-time sign-in code.
   *
   * The last of three barriers rather than the fix: production does not select the log
   * sender at all (`RefusingCodeSender`), and the log sender does not print the code there
   * either (`LogCodeSender`). This one covers the mistake neither of those can — some
   * future line, in some unrelated file, that logs a code without thinking about it.
   *
   * Nothing else logs a field called `code`; error codes travel inside a serialised
   * `error` object, and `redact` only looks at the keys it is given.
   */
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
  /**
   * Lets `code` through the redaction above. Off unless a caller asks, and the composition
   * root only asks outside production.
   *
   * The exception exists because on a laptop the log *is* the delivery channel: `pnpm dev`,
   * `scripts/mcp-smoke.md` and `e2e/src/live-mcp.smoke.test.ts` all sign in by grepping
   * `signup_code` out of a file, and with no way to read a code there is no way to run the
   * product locally at all. It is a flag rather than a rename because a renamed field would
   * defeat the list for every future caller too, and the list has to keep protecting the
   * accidental case — which is the only case it was ever for.
   *
   * It buys nothing in production and is not set there. If `NODE_ENV` were ever wrong the
   * refusal to deliver by log would already be off as well, so this adds no failure mode
   * that the two barriers in front of it do not already have.
   */
  revealSignupCode?: boolean;
}

export function createLogger(options: LoggerOptions = {}): Logger {
  const level = options.level ?? 'info';
  const base = options.base ?? {};
  const write = options.write ?? ((line: string) => process.stdout.write(`${line}\n`));
  const now = options.now ?? (() => new Date());
  const allow = options.revealSignupCode === true ? ['code'] : [];

  function emit(logLevel: LogLevel, message: string, fields?: LogFields): void {
    if (LEVEL_ORDER[logLevel] < LEVEL_ORDER[level]) return;
    const line = {
      ts: now().toISOString(),
      level: logLevel,
      msg: message,
      ...redact(base, allow),
      ...redact(fields ?? {}, allow),
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

export function redact(fields: LogFields, allow: readonly string[] = []): LogFields {
  const out: LogFields = {};
  for (const [key, value] of Object.entries(fields)) {
    const lower = key.toLowerCase();
    const redacted = REDACTED_KEYS.has(lower) && !allow.includes(lower);
    out[key] = redacted ? '[redacted]' : value;
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
