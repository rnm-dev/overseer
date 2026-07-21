import type { GithubProfile } from "../../github.js";

export type OAuthFlow = "web" | "native";

export interface OauthStartResult {
  authorizationUrl: string;
  state: string;
}

export interface OauthAttempt {
  flow: OAuthFlow;
  callbackUrl: string;
}

export interface WebSignInResult {
  flow: "web";
  token: string;
  user: UserRecord;
  device: DeviceView;
}

export interface NativeSignInResult {
  flow: "native";
  redirectUrl: string;
}

export type OAuthSignInCompletion = NativeSignInResult | WebSignInResult;

export interface UserRecord {
  id: string;
  email: string;
  createdAt: number;
  githubId: string | null;
  githubLogin: string | null;
  avatarUrl: string | null;
}

export interface ClientInfo {
  ip: string | null;
  userAgent: string | null;
}

export interface NativeExchangeResult {
  token: string;
  user: UserRecord;
  device: DeviceView;
}

export interface DeviceView {
  id: string;
  label: string | null;
  createdAt: number;
  lastSeenAt: number | null;
  expiresAt: number;
}

export interface DeviceInput {
  userId: string;
  label: string | null;
  client: ClientInfo;
}

export interface AuthContext {
  userId: string;
  email: string;
  githubLogin: string | null;
  avatarUrl: string | null;
  deviceId: string;
}
