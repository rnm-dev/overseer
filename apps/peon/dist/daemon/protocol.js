// Stable protocol version shared by inbound HTTP and outbound Overseer adapters.
// Keeping it transport-neutral prevents feature modules from importing agentApi.
export const PROTOCOL_VERSION = 1;
