type LogLevel = 'debug' | 'info' | 'warn' | 'error';

interface Logger {
  debug: (msg: string, ctx?: Record<string, unknown>) => void;
  info: (msg: string, ctx?: Record<string, unknown>) => void;
  warn: (msg: string, ctx?: Record<string, unknown>) => void;
  error: (msg: string, ctx?: Record<string, unknown>) => void;
}

function emit(level: LogLevel, msg: string, ctx?: Record<string, unknown>): void {
  const line = {
    t: new Date().toISOString(),
    level,
    msg,
    ...(ctx ?? {}),
  };
  // eslint-disable-next-line no-console
  console.log(JSON.stringify(line));
}

export const log: Logger = {
  debug: (m, c) => emit('debug', m, c),
  info: (m, c) => emit('info', m, c),
  warn: (m, c) => emit('warn', m, c),
  error: (m, c) => emit('error', m, c),
};
