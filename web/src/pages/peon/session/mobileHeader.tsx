import type { ReactNode } from "react";

export const MOBILE_SESSION_HEADER_ID = "mobile-session-header";

export function MobilePaneIdentity({ sessionActive, children }: { sessionActive: boolean; children?: ReactNode }) {
  return sessionActive
    ? <div id={MOBILE_SESSION_HEADER_ID} className="flex min-w-0 flex-1 items-center" />
    : <>{children}</>;
}
