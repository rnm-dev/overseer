export type OAuthFlow = "web" | "native";

/**
 * Which door an attempt belongs to. Stored, so a state cannot be redeemed at
 * another one, and so an app code can name the door that has to still be open
 * when it is spent.
 *
 * `password` is not a redirect flow and never has a state in the air — its row
 * is written already completed, purely to carry the app code its native ending
 * hands to the app.
 */
export type OAuthProvider = "github" | "oidc" | "password";

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
  // The invitation this flow was started with, on an instance that only accepts
  // invited accounts. Null everywhere else.
  inviteToken: string | null;
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
