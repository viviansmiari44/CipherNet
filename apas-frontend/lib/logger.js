import winston from 'winston';
import DailyRotateFile from 'winston-daily-rotate-file';
import { config } from './config.js';
import path from 'path';
import fs from 'fs';

// Detect if we are running in a serverless environment (like Vercel)
const isServerless = process.env.VERCEL === '1' || !!process.env.NEXT_RUNTIME;

const transports = [
  new winston.transports.Console({
    format: winston.format.combine(
      winston.format.colorize(),
      winston.format.simple()
    ),
  }),
];

// Only configure local file logging on your VPS/local machine
if (!isServerless) {
  const logDir = config.logging?.dir || './logs';
  try {
    if (!fs.existsSync(logDir)) {
      fs.mkdirSync(logDir, { recursive: true });
    }

    transports.push(
      new DailyRotateFile({
        filename: path.join(logDir, 'app-%DATE%.log'),
        datePattern: 'YYYY-MM-DD',
        maxSize: '20m',
        maxFiles: '14d',
        format: winston.format.combine(
          winston.format.timestamp(),
          winston.format.json()
        ),
      })
    );
  } catch (error) {
    console.warn('Failed to initialize file logger transport:', error.message);
  }
}

const logger = winston.createLogger({
  level: config.logging?.level || 'info',
  transports,
});

export default logger;