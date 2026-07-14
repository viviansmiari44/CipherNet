// Re-export the root notifier with a type that accepts string campaign IDs.
import { sendAlert as originalSendAlert } from '../../lib/notifier.js';

// The original function accepts a string for campaignId (plus null/undefined),
// so we cast it to the type that matches our usage.
export const sendAlert = originalSendAlert as (
  message: string,
  level?: string,
  campaignId?: string | null
) => Promise<void>;