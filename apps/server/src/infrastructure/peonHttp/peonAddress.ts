// The HTTP transport only needs the structural callback-address fields. Keeping
// this contract here prevents infrastructure from depending on the registry's
// product record while letting registry records satisfy it structurally.
export interface PeonAddressRecord {
  peonId: string;
  address: string;
  controlPort: number;
  publicUrl: string | null;
}

export interface PeonConnectionRecord extends PeonAddressRecord {
  token: string;
}

export function baseUrl(record: PeonAddressRecord): string {
  const callbackUrl = legacyCallbackUrl(record);
  if (!callbackUrl) throw new Error(`Peon ${record.peonId} has no legacy callback address`);
  return callbackUrl;
}

export function legacyCallbackUrl(record: PeonAddressRecord): string | null {
  if (record.publicUrl) return record.publicUrl;
  if (!record.address || !Number.isInteger(record.controlPort)
    || record.controlPort < 1 || record.controlPort > 65_535) return null;
  const host = record.address.includes(":") ? `[${record.address}]` : record.address;
  return `http://${host}:${record.controlPort}`;
}
