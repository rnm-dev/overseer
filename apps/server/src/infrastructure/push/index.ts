import { config } from "../../config.js";
import { createFcmSender, type PushSender } from "./fcm.js";
import type { FcmServiceAccount } from "./pushConfig.js";

// The public face of the push infrastructure: which providers this instance can
// actually deliver to, and the sender for the one that needs a credential.
//
// Unlike the voice providers, the FCM sender is memoised: it holds the OAuth
// access token shared by every message in a delivery pass, and rebuilding it per
// call would mint a fresh token each time. It is rebuilt only if the resolved
// service account itself changes.

export { createFcmSender, PushDeliveryError, type LiveActivityDelivery, type PushMessage, type PushSender } from "./fcm.js";
export { resolvePushConfig, type PushConfig, type FcmServiceAccount } from "./pushConfig.js";
export { plainText } from "./plainText.js";
export {
  appleDate,
  liveActivityPayload,
  liveActivityTopic,
  startAlert,
  ATTRIBUTES_TYPE,
  APPLE_REFERENCE_EPOCH_MS,
  STALE_AFTER_MS,
  TERMINAL_DISMISSAL_MS,
  type LiveActivityAlert,
  type LiveActivityAttributes,
  type LiveActivityContentState,
  type LiveActivityEvent,
} from "./liveActivity.js";

let sender: PushSender | null = null;
let senderAccount: FcmServiceAccount | null = null;

export function fcmEnabled(): boolean {
  return config.push.fcm !== null;
}

export function fcmSender(): PushSender | null {
  const account = config.push.fcm;
  if (!account) return null;
  if (!sender || senderAccount !== account) {
    senderAccount = account;
    sender = createFcmSender(account);
  }
  return sender;
}
