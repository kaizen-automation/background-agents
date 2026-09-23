import { validateKey, validateValue } from "../db/secrets-validation";

const DOWNLOAD_URL = "https://api.doppler.com/v3/configs/config/secrets/download?format=json";
const FETCH_TIMEOUT_MS = 10_000;
const MAX_RESPONSE_BYTES = 1_048_576;

export interface SandboxDopplerConfig {
  token?: string;
  repositories?: string;
  environmentIds?: string;
}

function includes(list: string | undefined, target: string): boolean {
  return (list ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean)
    .includes(target);
}

/** Tokens and Doppler's bookkeeping never belong in the sandbox environment. */
export function stripDopplerCredentials(
  secrets: Record<string, string>,
  token?: string
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(secrets).filter(
      ([key, value]) =>
        !key.toUpperCase().startsWith("DOPPLER_") &&
        !key.toUpperCase().startsWith("SANDBOX_DOPPLER_") &&
        (!token || !value.includes(token))
    )
  );
}

/** Only explicitly authorized session targets can use this deployment credential. */
export async function loadSandboxDopplerSecrets(
  config: SandboxDopplerConfig,
  target: { environmentId: string | null; repository: string | null },
  fetcher: typeof fetch = fetch
): Promise<Record<string, string> | null> {
  const selected =
    target.environmentId !== null
      ? includes(config.environmentIds, target.environmentId)
      : target.repository !== null && includes(config.repositories, target.repository);
  if (!selected) return null;
  if (!config.token) throw new Error("Sandbox Doppler token is not configured");

  // Never propagate response bodies, URLs from redirects, or fetch errors into logs.
  try {
    const response = await fetcher(DOWNLOAD_URL, {
      headers: { Authorization: `Bearer ${config.token}`, Accept: "application/json" },
      redirect: "error",
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!response.ok || !response.body) throw new Error();
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > MAX_RESPONSE_BYTES) throw new Error();
        chunks.push(value);
      }
    } finally {
      await reader.cancel();
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
    const entries = Object.entries(parsed);
    for (const [, value] of entries) validateValue(value);
    const secrets = stripDopplerCredentials(Object.fromEntries(entries), config.token);
    for (const key of Object.keys(secrets)) validateKey(key);
    return secrets;
  } catch {
    throw new Error("Unable to load sandbox secrets from Doppler");
  }
}
