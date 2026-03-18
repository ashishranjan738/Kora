import pino from 'pino';

const level = process.env.KORA_LOG_LEVEL || 'info';

export const logger = pino({
  level,
  transport: process.env.NODE_ENV !== 'production' ? { target: 'pino-pretty', options: { colorize: true } } : undefined,
});

export default logger;
