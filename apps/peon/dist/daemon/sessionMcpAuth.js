import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
export const SESSION_MCP_HEADER = "x-peon-session-capability";
const sessionMcpSecret = randomBytes(32);
export function sessionMcpCredential(sessionId) {
    const signature = createHmac("sha256", sessionMcpSecret).update(sessionId).digest("base64url");
    return `${Buffer.from(sessionId, "utf8").toString("base64url")}.${signature}`;
}
export function verifySessionMcpCredential(value) {
    if (typeof value !== "string")
        return null;
    const separator = value.indexOf(".");
    if (separator <= 0 || separator === value.length - 1)
        return null;
    let sessionId;
    try {
        sessionId = Buffer.from(value.slice(0, separator), "base64url").toString("utf8");
    }
    catch {
        return null;
    }
    if (!sessionId || Buffer.from(sessionId, "utf8").toString("base64url") !== value.slice(0, separator))
        return null;
    const expected = sessionMcpCredential(sessionId);
    const actualBuffer = Buffer.from(value);
    const expectedBuffer = Buffer.from(expected);
    return actualBuffer.length === expectedBuffer.length && timingSafeEqual(actualBuffer, expectedBuffer)
        ? sessionId
        : null;
}
