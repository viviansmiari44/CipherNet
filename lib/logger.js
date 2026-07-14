import winston from 'winston';
import DailyRotateFile from 'winston-daily-rotate-file';
import { config } from './config.js';
import path from 'path';
import fs from 'fs';

const logDir = config.logging.dir;
if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });

const transports = [
  new DailyRotateFile({
    filename: path.join(logDir, 'app-%DATE%.log'),
    datePattern: 'YYYY-MM-DD',
    maxSize: '20m',
    maxFiles: '14d',
    format: winston.format.combine(
      winston.format.timestamp(),
      winston.format.json()
    ),
  }),
  new winston.transports.Console({
    format: winston.format.combine(
      winston.format.colorize(),
      winston.format.simple()
    ),
  }),
];

const logger = winston.createLogger({
  level: config.logging.level,
  transports,
});

export default logger;