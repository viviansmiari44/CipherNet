import time
from functools import wraps
from .logger import logger

def retry(max_attempts=3, base_delay=1, backoff=2, exceptions=(Exception,), should_retry=None):
    def decorator(func):
        @wraps(func)
        def wrapper(*args, **kwargs):
            last_exc = None
            for attempt in range(1, max_attempts + 1):
                try:
                    return func(*args, **kwargs)
                except exceptions as e:
                    last_exc = e
                    if should_retry and not should_retry(e):
                        raise
                    if attempt == max_attempts:
                        break
                    delay = base_delay * (backoff ** (attempt - 1))
                    logger.warning(f"Retry {attempt}/{max_attempts} for {func.__name__} after {delay}s: {e}")
                    time.sleep(delay)
            raise last_exc
        return wrapper
    return decorator