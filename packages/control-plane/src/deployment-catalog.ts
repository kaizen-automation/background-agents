/**
 * Deployment catalog: the models and harnesses this deployment can actually
 * run, as declared by the operator (`MODEL_ALLOWLIST`, `HARNESS_ALLOWLIST`).
 *
 * The shared catalog lists everything the code knows how to drive; a
 * deployment only has credentials for some of it. The allowlists narrow the
 * shared catalog once, at the edge, so nothing outside them can be enabled in
 * model preferences, selected at session or automation create, or dispatched
 * to a sandbox. An empty or unset allowlist means the whole shared catalog.
 *
 * Unknown ids fail loudly (the #1602 posture): a typo in Terraform must not
 * silently drop a model from production.
 */

import {
  DEFAULT_HARNESS,
  HARNESS_IDS,
  isValidHarness,
  type HarnessId,
} from "@open-inspect/shared/harnesses";
import {
  DEFAULT_MODEL,
  VALID_MODELS,
  isValidModel,
  normalizeModelId,
  type ValidModel,
} from "@open-inspect/shared/models";

export interface DeploymentCatalogEnv {
  MODEL_ALLOWLIST?: string;
  HARNESS_ALLOWLIST?: string;
}

export interface DeploymentCatalog {
  /** Canonical model ids this deployment may run, in shared-catalog order. */
  readonly models: readonly ValidModel[];
  /** Harnesses this deployment may run, in shared-catalog order. */
  readonly harnesses: readonly HarnessId[];
  /** Whether either allowlist narrows the shared catalog. */
  readonly restricted: boolean;
}

export class DeploymentCatalogError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DeploymentCatalogError";
  }
}

function splitAllowlist(raw: string | undefined): string[] {
  return (raw ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

function parseModelAllowlist(raw: string | undefined): readonly ValidModel[] {
  const entries = splitAllowlist(raw);
  if (entries.length === 0) return VALID_MODELS;
  const allowed = new Set<ValidModel>();
  for (const entry of entries) {
    if (!isValidModel(entry)) {
      throw new DeploymentCatalogError(
        `MODEL_ALLOWLIST contains unknown model "${entry}"; valid models: ${VALID_MODELS.join(", ")}`
      );
    }
    allowed.add(normalizeModelId(entry) as ValidModel);
  }
  return VALID_MODELS.filter((model) => allowed.has(model));
}

function parseHarnessAllowlist(raw: string | undefined): readonly HarnessId[] {
  const entries = splitAllowlist(raw);
  if (entries.length === 0) return HARNESS_IDS;
  const allowed = new Set<HarnessId>();
  for (const entry of entries) {
    if (!isValidHarness(entry)) {
      throw new DeploymentCatalogError(
        `HARNESS_ALLOWLIST contains unknown harness "${entry}"; valid harnesses: ${HARNESS_IDS.join(", ")}`
      );
    }
    allowed.add(entry);
  }
  return HARNESS_IDS.filter((harness) => allowed.has(harness));
}

const catalogCache = new Map<string, DeploymentCatalog>();

/** Parse the allowlists once per distinct configuration; the Worker env is static. */
export function getDeploymentCatalog(env: DeploymentCatalogEnv): DeploymentCatalog {
  const cacheKey = `${env.MODEL_ALLOWLIST ?? ""}\n${env.HARNESS_ALLOWLIST ?? ""}`;
  const cached = catalogCache.get(cacheKey);
  if (cached) return cached;

  const models = parseModelAllowlist(env.MODEL_ALLOWLIST);
  const harnesses = parseHarnessAllowlist(env.HARNESS_ALLOWLIST);
  const catalog: DeploymentCatalog = {
    models,
    harnesses,
    restricted: models.length !== VALID_MODELS.length || harnesses.length !== HARNESS_IDS.length,
  };
  catalogCache.set(cacheKey, catalog);
  return catalog;
}

export function isModelAvailable(catalog: DeploymentCatalog, model: string): boolean {
  return isValidModel(model) && catalog.models.includes(normalizeModelId(model) as ValidModel);
}

export function isHarnessAvailable(catalog: DeploymentCatalog, harness: string): boolean {
  return isValidHarness(harness) && catalog.harnesses.includes(harness);
}

/** The shared default model when the deployment runs it, else the first available model. */
export function getDefaultAvailableModel(catalog: DeploymentCatalog): ValidModel {
  return catalog.models.includes(DEFAULT_MODEL) ? DEFAULT_MODEL : catalog.models[0];
}

/** The shared default harness when the deployment runs it, else the first available harness. */
export function getDefaultAvailableHarness(catalog: DeploymentCatalog): HarnessId {
  return catalog.harnesses.includes(DEFAULT_HARNESS) ? DEFAULT_HARNESS : catalog.harnesses[0];
}

export interface DeploymentCatalogRejection {
  readonly message: string;
}

/**
 * Resolve a requested model against the deployment: an absent request takes
 * the deployment default; an explicit model outside the deployment is
 * rejected rather than silently substituted.
 */
export function resolveAvailableModel(
  catalog: DeploymentCatalog,
  requested: string | null | undefined
): ValidModel | DeploymentCatalogRejection {
  if (requested === undefined || requested === null || requested === "") {
    return getDefaultAvailableModel(catalog);
  }
  if (!isModelAvailable(catalog, requested)) {
    return { message: `Model "${requested}" is not available in this deployment.` };
  }
  return normalizeModelId(requested) as ValidModel;
}

/** Harness counterpart of `resolveAvailableModel`. */
export function resolveAvailableHarness(
  catalog: DeploymentCatalog,
  requested: string | null | undefined
): HarnessId | DeploymentCatalogRejection {
  if (requested === undefined || requested === null || requested === "") {
    return getDefaultAvailableHarness(catalog);
  }
  if (!isHarnessAvailable(catalog, requested)) {
    return { message: `Harness "${requested}" is not available in this deployment.` };
  }
  return requested as HarnessId;
}

export function isDeploymentCatalogRejection(value: unknown): value is DeploymentCatalogRejection {
  return typeof value === "object" && value !== null && "message" in value;
}
