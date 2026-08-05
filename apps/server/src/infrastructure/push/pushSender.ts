import { config } from "../config/index.js";
import { createFcmSender, type PushSender } from "./fcm.js";
import type { FcmServiceAccount } from "./pushConfig.js";

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
