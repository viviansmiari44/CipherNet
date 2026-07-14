import logging
import sys
import os
from logging.handlers import RotatingFileHandler
from .config import config

def setup_logger(name):
    logger = logging.getLogger(name)
    logger.setLevel(getattr(logging, config.LOG_LEVEL.upper(), logging.INFO))

    # Console handler
    ch = logging.StreamHandler(sys.stdout)
    ch.setLevel(logging.INFO)
    formatter = logging.Formatter('%(asctime)s - %(name)s - %(levelname)s - %(message)s')
    ch.setFormatter(formatter)
    logger.addHandler(ch)

    # File handler (rotating)
    if not os.path.exists(config.LOG_DIR):
        os.makedirs(config.LOG_DIR, exist_ok=True)
    fh = RotatingFileHandler(
        os.path.join(config.LOG_DIR, 'duster.log'),
        maxBytes=20*1024*1024,
        backupCount=5
    )
    fh.setLevel(logging.DEBUG)
    fh.setFormatter(formatter)
    logger.addHandler(fh)

    return logger

logger = setup_logger('duster')