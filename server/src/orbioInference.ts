import { AiError } from "@/lib/ai/errors";
import { PersistenceError } from "./persistence";
import {
  loadOrbioCredentialForInference,
  markOrbioConnectionInvalid,
  type OrbioInferenceCredential,
} from "./orbioConnectionService";

interface InferenceCredentialDependencies {
  load: typeof loadOrbioCredentialForInference;
  markInvalid: typeof markOrbioConnectionInvalid;
}

const defaults: InferenceCredentialDependencies = {
  load: loadOrbioCredentialForInference,
  markInvalid: markOrbioConnectionInvalid,
};

/**
 * Runs exactly one caller-supplied provider operation with the locally loaded
 * credential. A real 401/403 is the authorization check for inference paths.
 */
export async function runOrbioInference<T>(
  userId: string,
  operation: (credential: OrbioInferenceCredential) => Promise<T>,
  loadedCredential?: OrbioInferenceCredential,
  dependencies: InferenceCredentialDependencies = defaults,
): Promise<T> {
  const credential = loadedCredential ?? await dependencies.load(userId);
  try {
    return await operation(credential);
  } catch (error) {
    if (error instanceof AiError && error.code === "AI_AUTH_FAILED") {
      await dependencies.markInvalid(userId);
      throw new PersistenceError("ORBIO_KEY_EXPIRED_OR_INVALID", "Orbio rejected the saved key. Reconnect your key.", 400);
    }
    throw error;
  }
}
