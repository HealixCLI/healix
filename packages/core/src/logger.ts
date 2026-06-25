export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const order: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };
let current: LogLevel = (process.env.HEALIX_LOG as LogLevel) || 'info';

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
