export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const order: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };
const DEFAULT_LEVEL: LogLevel = 'info';

/**
 * Validate HEALIX_LOG against the known levels. The previous bare
 * `as LogLevel` cast let any value (e.g. HEALIX_LOG=verbose) through, making
 * `order[current]` undefined — and since every `<` comparison with undefined
 * is false, the filter silently disabled itself and EVERYTHING logged.
 * Unknown values now fall back to the default level instead.
 */
function parseLevel(raw: string | undefined): LogLevel {
  return raw && raw in order ? (raw as LogLevel) : DEFAULT_LEVEL;
}

let current: LogLevel = parseLevel(process.env.HEALIX_LOG);

export function setLogLevel(level: LogLevel): void {
  current = level;
}

function emit(level: LogLevel, args: unknown[]): void {
  if (order[level] < order[current]) return;
  const tag = `[healix:${level}]`;
  const sink = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log;
  sink(tag, ...args);
}

export const logger = {
  debug: (...a: unknown[]) => emit('debug', a),
  info: (...a: unknown[]) => emit('info', a),
  warn: (...a: unknown[]) => emit('warn', a),
  error: (...a: unknown[]) => emit('error', a),
};
