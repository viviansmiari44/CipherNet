import signal
import sys
from .logger import logger

def setup_graceful_shutdown():
    def handler(signum, frame):
        logger.info(f"Received signal {signum}. Shutting down gracefully...")
        sys.exit(0)
    signal.signal(signal.SIGINT, handler)
    signal.signal(signal.SIGTERM, handler)