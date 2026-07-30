const OPERATOR_CODE = /^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/;

export function claimCodeForPage(routeCode: string, storedCode: string | null): string {
  if (OPERATOR_CODE.test(routeCode)) return routeCode;
  return storedCode && OPERATOR_CODE.test(storedCode) ? storedCode : "";
}

export function claimResolveBody(operatorCode: string): {
  type: "claim_resolve";
  protocol: 1;
  operatorCode: string;
} {
  return { type: "claim_resolve", protocol: 1, operatorCode };
}

export function claimDecisionPath(workspaceId: string, claimId: string): string {
  return `/workspaces/${encodeURIComponent(workspaceId)}/peon-claims/${encodeURIComponent(claimId)}/decision`;
}
