import pino from 'pino';

export type AppLogger = pino.Logger;

export function createLogger(opts: {
  logPath?:  string;
  logLevel:  string;
}): AppLogger {
  const dest = opts.logPath
    ? pino.destination({ dest: opts.logPath, sync: false })
    : pino.destination(2); // fd 2 = stderr

  return pino(
    {
      level: opts.logLevel,
      base: { pid: process.pid },
      timestamp: pino.stdTimeFunctions.isoTime,
    },
    dest,
  );
}
