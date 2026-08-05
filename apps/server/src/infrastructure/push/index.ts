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
export { cancelPendingPush } from "./pushOutbox.js";
export { disableLiveActivitiesForDevice } from "./liveActivityDeviceCleanup.js";
export { fcmEnabled, fcmSender } from "./pushSender.js";
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
