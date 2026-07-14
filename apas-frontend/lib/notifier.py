import requests
import os
from .config import config
from .logger import logger

# Initialize Supabase client if credentials available
SUPABASE_URL = os.getenv("NEXT_PUBLIC_SUPABASE_URL")
SUPABASE_KEY = os.getenv("SUPABASE_SERVICE_ROLE_KEY")  # Use service role for internal updates

if SUPABASE_URL and SUPABASE_KEY:
    try:
        from supabase import create_client
        supabase = create_client(SUPABASE_URL, SUPABASE_KEY)
    except ImportError:
        supabase = None
        logger.warning("supabase-py not installed; Telegram per-user notifications disabled.")
else:
    supabase = None

def _get_user_telegram_config(campaign_id):
    """Fetch the user's telegram bot token and chat ID from the database."""
    if not supabase:
        return None, None
    try:
        # Query campaigns joined with users
        result = supabase.table("campaigns").select("user_id").eq("id", campaign_id).execute()
        if not result.data:
            return None, None
        user_id = result.data[0]["user_id"]
        user_result = supabase.table("users").select("telegram_bot_token, telegram_chat_id").eq("id", user_id).execute()
        if not user_result.data:
            return None, None
        user = user_result.data[0]
        return user.get("telegram_bot_token"), user.get("telegram_chat_id")
    except Exception as e:
        logger.error(f"Failed to fetch Telegram config: {e}")
        return None, None

def send_telegram(message, campaign_id=None):
    """
    Send a Telegram message. If campaign_id is provided, use the user's own bot token/chat ID.
    Otherwise, fall back to global config.
    """
    token = None
    chat_id = None

    if campaign_id:
        token, chat_id = _get_user_telegram_config(campaign_id)
        if token and chat_id:
            # Use user-specific config
            pass
        else:
            # Fallback to global config
            token = config.TELEGRAM_BOT_TOKEN
            chat_id = config.TELEGRAM_CHAT_ID
    else:
        token = config.TELEGRAM_BOT_TOKEN
        chat_id = config.TELEGRAM_CHAT_ID

    if not token or not chat_id:
        return

    try:
        url = f"https://api.telegram.org/bot{token}/sendMessage"
        payload = {
            "chat_id": chat_id,
            "text": message,
            "parse_mode": "HTML"
        }
        requests.post(url, json=payload, timeout=5)
    except Exception as e:
        logger.error(f"Telegram alert failed: {e}")