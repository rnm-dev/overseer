import type { ReactNode } from "react";

export const MOBILE_CONTENT_HEADER_ID = "mobile-content-header";

export function MobilePaneIdentity({ contentActive, children }: { contentActive: boolean; children?: ReactNode }) {
  return contentActive
    ? <div id={MOBILE_CONTENT_HEADER_ID} className="flex min-w-0 flex-1 items-center" />
    : <>{children}</>;
}
