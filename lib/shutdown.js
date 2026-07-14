import logger from './logger.js';

let shutdownCallbacks = [];

export function onShutdown(callback) {
  shutdownCallbacks.push(callback);
}

export function setupGracefulShutdown() {
  const shutdown = async (signal) => {
    logger.info(`Received ${signal}. Shutting down gracefully...`);
    for (const cb of shutdownCallbacks) {
      try {
        await cb();
      } catch (err) {
        logger.error(`Shutdown callback error: ${err.message}`);
      }
    }
    process.exit(0);
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}