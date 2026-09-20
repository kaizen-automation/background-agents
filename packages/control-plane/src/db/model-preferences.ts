import {
  DEFAULT_ENABLED_MODELS,
  applyModelPreferenceChanges,
  isValidModel,
  normalizeValidModels,
  normalizeModelId,
  type ModelPreferenceChange,
  type ValidModel,
} from "@open-inspect/shared/models";
import type { SqlDatabase } from "./sql-database";
import { getDeploymentCatalog, type DeploymentCatalog } from "../deployment-catalog";

const MAX_MODEL_PREFERENCE_WRITE_ATTEMPTS = 3;

export class ModelPreferencesValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ModelPreferencesValidationError";
  }
}

export class ModelPreferencesConflictError extends Error {
  constructor() {
    super("Model preferences changed too frequently; retry the update");
    this.name = "ModelPreferencesConflictError";
  }
}

interface ModelPreferencesRow {
  enabled_models: string;
  revision: number;
}

export interface ModelPreferencesSnapshot {
  /** Enabled models, already narrowed to `availableModels`. */
  enabledModels: ValidModel[];
  /** Models this deployment can run at all (the operator allowlist). */
  availableModels: ValidModel[];
  revision: number;
}

const UNRESTRICTED_CATALOG = getDeploymentCatalog({});

export class ModelPreferencesStore {
  constructor(
    private readonly db: SqlDatabase,
    private readonly catalog: DeploymentCatalog = UNRESTRICTED_CATALOG
  ) {}

  /** Resolve persisted preferences through the canonical decoding policy. */
  async getSnapshot(): Promise<ModelPreferencesSnapshot> {
    const row = await this.db
      .prepare("SELECT enabled_models, revision FROM model_preferences WHERE id = 'global'")
      .first<ModelPreferencesRow>();
    return this.decodeSnapshot(row);
  }

  async getEnabledModels(): Promise<ValidModel[]> {
    return (await this.getSnapshot()).enabledModels;
  }

  /** Apply set-membership changes with compare-and-swap retries across concurrent writers. */
  async applyChanges(changes: readonly ModelPreferenceChange[]): Promise<ModelPreferencesSnapshot> {
    this.validateChanges(changes);

    for (let attempt = 0; attempt < MAX_MODEL_PREFERENCE_WRITE_ATTEMPTS; attempt += 1) {
      const row = await this.db
        .prepare("SELECT enabled_models, revision FROM model_preferences WHERE id = 'global'")
        .first<ModelPreferencesRow>();
      const current = this.decodeSnapshot(row);
      const next = applyModelPreferenceChanges(current.enabledModels, changes);
      if (next.length === 0) {
        throw new ModelPreferencesValidationError("At least one model must be enabled");
      }

      const now = Date.now();
      const result = row
        ? await this.db
            .prepare(
              `UPDATE model_preferences
               SET enabled_models = ?, updated_at = ?, revision = revision + 1
               WHERE id = 'global' AND revision = ?`
            )
            .bind(JSON.stringify(next), now, row.revision)
            .run()
        : await this.db
            .prepare(
              `INSERT INTO model_preferences (id, enabled_models, updated_at, revision)
               VALUES ('global', ?, ?, 1)
               ON CONFLICT(id) DO NOTHING`
            )
            .bind(JSON.stringify(next), now)
            .run();

      if (result.meta.changes === 1) {
        return this.narrowToDeployment(next, row ? row.revision + 1 : 1);
      }
    }

    throw new ModelPreferencesConflictError();
  }

  private validateChanges(changes: readonly ModelPreferenceChange[]): void {
    if (changes.length === 0) {
      throw new ModelPreferencesValidationError("At least one model preference change is required");
    }

    const seen = new Set<string>();
    for (const change of changes) {
      if (!isValidModel(change.modelId) || normalizeModelId(change.modelId) !== change.modelId) {
        throw new ModelPreferencesValidationError(`Invalid canonical model ID: ${change.modelId}`);
      }
      if (change.enabled && !this.catalog.models.includes(change.modelId)) {
        throw new ModelPreferencesValidationError(
          `Model ${change.modelId} is not available in this deployment`
        );
      }
      if (seen.has(change.modelId)) {
        throw new ModelPreferencesValidationError(`Duplicate model preference: ${change.modelId}`);
      }
      seen.add(change.modelId);
    }
  }

  /**
   * Intersect persisted preferences with the deployment allowlist. A
   * preference set that leaves nothing runnable (e.g. the allowlist changed
   * under it) falls back to the whole allowlist rather than an empty picker.
   */
  private narrowToDeployment(
    enabled: readonly ValidModel[],
    revision: number
  ): ModelPreferencesSnapshot {
    const available = [...this.catalog.models];
    const availableSet = new Set(available);
    const narrowed = enabled.filter((model) => availableSet.has(model));
    return {
      enabledModels: narrowed.length > 0 ? narrowed : available,
      availableModels: available,
      revision,
    };
  }

  private decodeSnapshot(row: ModelPreferencesRow | null): ModelPreferencesSnapshot {
    if (!row) {
      return this.narrowToDeployment(DEFAULT_ENABLED_MODELS, 0);
    }

    let stored: string[] | null = null;
    try {
      const parsed: unknown = JSON.parse(row.enabled_models);
      if (Array.isArray(parsed) && parsed.every((id) => typeof id === "string")) {
        stored = parsed;
      }
    } catch {
      // Malformed persisted values use the same default snapshot as unusable arrays.
    }

    const normalized = normalizeValidModels(stored ?? []);
    const enabledModels = normalized.length > 0 ? normalized : DEFAULT_ENABLED_MODELS;
    return this.narrowToDeployment(enabledModels, row.revision);
  }
}

/**
 * Resolve the currently enabled catalog, using defaults only when no usable
 * preferences exist, narrowed to what this deployment can run.
 */
export async function getEffectiveEnabledModels(
  db: SqlDatabase,
  catalog: DeploymentCatalog = UNRESTRICTED_CATALOG
): Promise<ValidModel[]> {
  return new ModelPreferencesStore(db, catalog).getEnabledModels();
}
