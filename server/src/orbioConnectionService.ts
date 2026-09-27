import { createHash } from "node:crypto";
import {
  PersistenceError,
  decryptOrbioKey,
  deleteOrbioConnection,
  encryptOrbioKey,
  fingerprint,
  readOrbioConnection,
  requireCredentialEncryptionKey,
  saveOrbioConnection,
  updateOrbioConnectionStatus,
  type OrbioConnectionRecord,
} from "./persistence";
import { getOrbioBalance, verifyOrbioKey, type OrbioBalance } from "./orbioService";

export interface VerifiedOrbioConnection {
  /** Backend-memory only. Never serialize this object directly. */
  apiKey: string;
  fingerprint: string;
  modelIds: string[];
  balance: OrbioBalance | null;
}

export interface SafeOrbioStatus {
  connected: boolean;
  status: OrbioConnectionRecord["status"];
  keyFingerprint?: string;
  modelIds: string[];
  balance: OrbioBalance | null;
}

interface ConnectionDependencies {
  read: typeof readOrbioConnection;
  save: typeof saveOrbioConnection;
  updateStatus: typeof updateOrbioConnectionStatus;
  remove: typeof deleteOrbioConnection;
  encrypt: typeof encryptOrbioKey;
  decrypt: typeof decryptOrbioKey;
  verify: typeof verifyOrbioKey;
  balance: typeof getOrbioBalance;
  requireEncryption: typeof requireCredentialEncryptionKey;
  now: () => string;
}

const defaults: ConnectionDependencies = {
  read: readOrbioConnection,
  save: saveOrbioConnection,
  updateStatus: updateOrbioConnectionStatus,
  remove: deleteOrbioConnection,
  encrypt: encryptOrbioKey,
  decrypt: decryptOrbioKey,
  verify: verifyOrbioKey,
  balance: getOrbioBalance,
  requireEncryption: requireCredentialEncryptionKey,
  now: () => new Date().toISOString(),
};

function safeUser(userId: string): string {
  return createHash("sha256").update(userId).digest("hex").slice(0, 12);
}

function log(event: string, userId: string, fields: Record<string, string>): void {
  const details = Object.entries(fields).map(([key, value]) => `${key}=${value}`).join(" ");
  console.info(`[orbio] event=${event} user=${safeUser(userId)} ${details}`.trim());
}

function providerError(error: unknown): PersistenceError {
  if (error instanceof PersistenceError && (error.code === "ORBIO_KEY_INVALID" || error.code === "ORBIO_KEY_EXPIRED_OR_INVALID")) {
    return new PersistenceError("ORBIO_KEY_EXPIRED_OR_INVALID", "Orbio rejected the saved key. Reconnect your key.", 400);
  }
  if (error instanceof PersistenceError && error.code === "ORBIO_NOT_CONFIGURED") return error;
  return new PersistenceError("ORBIO_PROVIDER_UNAVAILABLE", "Orbio is temporarily unavailable. Try again shortly.", 503);
}

export function createOrbioConnectionService(overrides: Partial<ConnectionDependencies> = {}) {
  const dependencies = { ...defaults, ...overrides };

  async function loadActiveRecord(userId: string): Promise<{ record: OrbioConnectionRecord; apiKey: string }> {
    dependencies.requireEncryption();
    const record = await dependencies.read(userId);
    if (!record) throw new PersistenceError("ORBIO_NOT_CONNECTED", "Connect your Orbio account before starting a project.", 400);
    if (record.status !== "active") throw new PersistenceError("ORBIO_CONNECTION_INACTIVE", "Your saved Orbio connection is inactive. Reconnect it.", 400);
    if (!record.encryptedKey) throw new PersistenceError("ORBIO_CREDENTIAL_UNREADABLE", "Your saved Orbio connection can no longer be read. Reconnect your Orbio key.", 400);
    try {
      const apiKey = dependencies.decrypt(record.encryptedKey).trim();
      if (!apiKey) throw new Error("empty credential");
      return { record, apiKey };
    } catch (error) {
      if (error instanceof PersistenceError && error.code === "CREDENTIAL_ENCRYPTION_NOT_CONFIGURED") throw error;
      log("connection_validation", userId, { failure: "credential_decryption" });
      throw new PersistenceError("ORBIO_CREDENTIAL_UNREADABLE", "Your saved Orbio connection can no longer be read. Reconnect your Orbio key.", 400);
    }
  }

  async function getVerified(userId: string): Promise<VerifiedOrbioConnection> {
    const { record, apiKey } = await loadActiveRecord(userId);
    let verified: Awaited<ReturnType<typeof verifyOrbioKey>>;
    try {
      verified = await dependencies.verify(apiKey);
    } catch (error) {
      const normalized = providerError(error);
      if (normalized.code === "ORBIO_KEY_EXPIRED_OR_INVALID") await dependencies.updateStatus(userId, "invalid").catch(() => undefined);
      log("connection_validation", userId, { failure: normalized.code.toLowerCase() });
      throw normalized;
    }
    const verifiedAt = dependencies.now();
    await dependencies.updateStatus(userId, "active", verifiedAt);
    const balance = await dependencies.balance(apiKey);
    return { apiKey, fingerprint: record.keyFingerprint, modelIds: verified.modelIds, balance };
  }

  async function connect(userId: string, rawApiKey: string): Promise<VerifiedOrbioConnection> {
    dependencies.requireEncryption();
    const apiKey = rawApiKey.trim();
    if (!apiKey) throw new PersistenceError("ORBIO_KEY_EXPIRED_OR_INVALID", "Enter an Orbio API key.", 400);
    try {
      await dependencies.verify(apiKey);
      log("connect", userId, { verification: "success" });
    } catch (error) {
      throw providerError(error);
    }

    const now = dependencies.now();
    await dependencies.save({
      userId,
      encryptedKey: dependencies.encrypt(apiKey),
      keyFingerprint: fingerprint(apiKey),
      status: "active",
      lastVerifiedAt: now,
    });
    log("connect", userId, { persistence: "success" });

    // Mandatory persistence round trip: getVerified reads, decrypts and
    // reverifies the saved value. The submitted plaintext is not trusted here.
    const connection = await getVerified(userId);
    log("connect", userId, { roundtrip_decryption: "success", provider_reverification: "success" });
    return connection;
  }

  async function status(userId: string): Promise<SafeOrbioStatus> {
    const record = await dependencies.read(userId);
    if (!record) return { connected: false, status: "disconnected", modelIds: [], balance: null };
    if (record.status !== "active") {
      return { connected: record.status !== "disconnected", status: record.status, keyFingerprint: record.keyFingerprint, modelIds: [], balance: null };
    }
    try {
      const connection = await getVerified(userId);
      return { connected: true, status: "active", keyFingerprint: connection.fingerprint, modelIds: connection.modelIds, balance: connection.balance };
    } catch (error) {
      if (error instanceof PersistenceError && (error.code === "CREDENTIAL_ENCRYPTION_NOT_CONFIGURED" || error.code === "ORBIO_PROVIDER_UNAVAILABLE" || error.code === "ORBIO_NOT_CONFIGURED")) throw error;
      return { connected: true, status: "invalid", keyFingerprint: record.keyFingerprint, modelIds: [], balance: null };
    }
  }

  return { connect, getVerified, status, disconnect: dependencies.remove };
}

const service = createOrbioConnectionService();

export const connectOrbioConnection = service.connect;
export const getVerifiedOrbioConnection = service.getVerified;
export const getOrbioConnectionStatus = service.status;
export const disconnectOrbioConnection = service.disconnect;
