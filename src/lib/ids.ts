/** Generates RFC 4122 version 4 identifiers for application-owned UUID columns. */
export function createUuid(): string {
  const cryptoApi = globalThis.crypto;
  if (!cryptoApi?.randomUUID) {
    throw new Error("Secure UUID generation is unavailable in this runtime.");
  }
  return cryptoApi.randomUUID();
}

export const UUID_V4_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
