import pino from 'pino';

// Allowlisted logging (docs/SECURITY.md §6). Only event names and numeric fields are
// accepted, so pseudonyms, IPs, ids, and frame contents cannot end up in logs by accident.
export type LogFields = Record<string, number | boolean>;

export interface EventLogger {
  info(event: string, fields?: LogFields): void;
  warn(event: string, fields?: LogFields): void;
  error(event: string, fields?: LogFields): void;
}

export function createLogger(level: string): EventLogger {
  const base = pino({ level, base: undefined, timestamp: pino.stdTimeFunctions.isoTime });
  const write = (fn: 'info' | 'warn' | 'error') => (event: string, fields: LogFields = {}) => {
    const safe: LogFields = {};
    for (const [k, v] of Object.entries(fields)) {
      if (typeof v === 'number' || typeof v === 'boolean') safe[k] = v;
    }
    base[fn]({ event, ...safe });
  };
  return { info: write('info'), warn: write('warn'), error: write('error') };
}

export const silentLogger: EventLogger = { info() {}, warn() {}, error() {} };

export const LOGGER = Symbol('LOGGER');
