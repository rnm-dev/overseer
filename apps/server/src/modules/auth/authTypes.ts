export type OAuthFlow = "web" | "native";

/** Which door an attempt belongs to. Stored, so a state cannot be redeemed at the other one. */
export type OAuthProvider = "github" | "oidc";

export interface OauthStartResult {
  authorizationUrl: string;
  state: string;
}

export interface OauthAttempt {
  flow: OAuthFlow;
  provider: OAuthProvider;
  callbackUrl: string;
  /** OIDC only: what the returning id token must carry, and the PKCE secret. */
  nonceDigest: string | null;
  codeVerifier: string | null;
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
  oidcIssuer: string | null;
  oidcSubject: string | null;
}

export interface ClientInfo {
  ip: string | null;
  userAgent: string | null;
}

export interface PasswordSignInResult {
  token: string;
  user: UserRecord;
  device: DeviceView;
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

/** Canonical user identity attached to authenticated server-side actions. */
export interface AuthenticatedActor {
  userId: string;
  email: string;
}
