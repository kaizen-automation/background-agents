import { describe, expect, it } from "vitest";
import { HARNESS_IDS } from "@open-inspect/shared/harnesses";
import { DEFAULT_MODEL, VALID_MODELS } from "@open-inspect/shared/models";
import {
  DeploymentCatalogError,
  getDefaultAvailableHarness,
  getDefaultAvailableModel,
  getDeploymentCatalog,
  isDeploymentCatalogRejection,
  isHarnessAvailable,
  isModelAvailable,
  resolveAvailableHarness,
  resolveAvailableModel,
} from "./deployment-catalog";

describe("getDeploymentCatalog", () => {
  it("exposes the whole shared catalog when no allowlist is configured", () => {
    const catalog = getDeploymentCatalog({});
    expect(catalog.models).toEqual(VALID_MODELS);
    expect(catalog.harnesses).toEqual(HARNESS_IDS);
    expect(catalog.restricted).toBe(false);
  });

  it("treats blank allowlists as unset", () => {
    const catalog = getDeploymentCatalog({ MODEL_ALLOWLIST: " , ", HARNESS_ALLOWLIST: "" });
    expect(catalog.restricted).toBe(false);
  });

  it("narrows models and harnesses in catalog order, canonicalizing short ids", () => {
    const catalog = getDeploymentCatalog({
      MODEL_ALLOWLIST: "anthropic/claude-opus-4-7, claude-sonnet-4-6 ,anthropic/claude-sonnet-4-6",
      HARNESS_ALLOWLIST: "opencode",
    });
    expect(catalog.models).toEqual(["anthropic/claude-sonnet-4-6", "anthropic/claude-opus-4-7"]);
    expect(catalog.harnesses).toEqual(["opencode"]);
    expect(catalog.restricted).toBe(true);
  });

  it("rejects unknown model ids instead of dropping them", () => {
    expect(() => getDeploymentCatalog({ MODEL_ALLOWLIST: "anthropic/claude-nope" })).toThrow(
      DeploymentCatalogError
    );
    expect(() => getDeploymentCatalog({ MODEL_ALLOWLIST: "anthropic/claude-nope" })).toThrow(
      /unknown model "anthropic\/claude-nope"/
    );
  });

  it("rejects unknown harness ids", () => {
    expect(() => getDeploymentCatalog({ HARNESS_ALLOWLIST: "codex" })).toThrow(
      /unknown harness "codex"/
    );
  });

  it("returns the same catalog instance for identical configuration", () => {
    const env = { MODEL_ALLOWLIST: "anthropic/claude-sonnet-5", HARNESS_ALLOWLIST: "opencode" };
    expect(getDeploymentCatalog(env)).toBe(getDeploymentCatalog({ ...env }));
  });
});

describe("availability checks", () => {
  const catalog = getDeploymentCatalog({
    MODEL_ALLOWLIST: "anthropic/claude-sonnet-5,anthropic/claude-opus-4-7",
    HARNESS_ALLOWLIST: "opencode",
  });

  it("accepts canonical and short ids inside the allowlist", () => {
    expect(isModelAvailable(catalog, "anthropic/claude-sonnet-5")).toBe(true);
    expect(isModelAvailable(catalog, "claude-opus-4-7")).toBe(true);
  });

  it("rejects catalog models outside the allowlist and unknown ids", () => {
    expect(isModelAvailable(catalog, DEFAULT_MODEL)).toBe(false);
    expect(isModelAvailable(catalog, "openai/gpt-6-astra")).toBe(false);
    expect(isModelAvailable(catalog, "not-a-model")).toBe(false);
  });

  it("rejects harnesses outside the allowlist", () => {
    expect(isHarnessAvailable(catalog, "opencode")).toBe(true);
    expect(isHarnessAvailable(catalog, "claude")).toBe(false);
    expect(isHarnessAvailable(catalog, "codex")).toBe(false);
  });
});

describe("default resolution", () => {
  it("keeps the shared defaults when they are available", () => {
    const catalog = getDeploymentCatalog({});
    expect(getDefaultAvailableModel(catalog)).toBe(DEFAULT_MODEL);
    expect(getDefaultAvailableHarness(catalog)).toBe("opencode");
  });

  it("falls back to the first allowed entry when the shared default is excluded", () => {
    const catalog = getDeploymentCatalog({
      MODEL_ALLOWLIST: "anthropic/claude-opus-4-7,anthropic/claude-sonnet-5",
      HARNESS_ALLOWLIST: "claude",
    });
    expect(getDefaultAvailableModel(catalog)).toBe("anthropic/claude-sonnet-5");
    expect(getDefaultAvailableHarness(catalog)).toBe("claude");
  });
});

describe("resolveAvailableModel / resolveAvailableHarness", () => {
  const catalog = getDeploymentCatalog({
    MODEL_ALLOWLIST: "anthropic/claude-sonnet-5",
    HARNESS_ALLOWLIST: "opencode",
  });

  it("resolves missing requests to the deployment default", () => {
    for (const requested of [undefined, null, ""]) {
      expect(resolveAvailableModel(catalog, requested)).toBe("anthropic/claude-sonnet-5");
      expect(resolveAvailableHarness(catalog, requested)).toBe("opencode");
    }
  });

  it("canonicalizes an allowed short id", () => {
    expect(resolveAvailableModel(catalog, "claude-sonnet-5")).toBe("anthropic/claude-sonnet-5");
  });

  it("rejects explicit requests outside the deployment", () => {
    const model = resolveAvailableModel(catalog, DEFAULT_MODEL);
    expect(isDeploymentCatalogRejection(model)).toBe(true);
    expect(model).toEqual({
      message: `Model "${DEFAULT_MODEL}" is not available in this deployment.`,
    });

    const harness = resolveAvailableHarness(catalog, "claude");
    expect(harness).toEqual({ message: 'Harness "claude" is not available in this deployment.' });
  });

  it("does not mistake resolved ids for rejections", () => {
    expect(isDeploymentCatalogRejection(resolveAvailableModel(catalog, undefined))).toBe(false);
    expect(isDeploymentCatalogRejection(resolveAvailableHarness(catalog, "opencode"))).toBe(false);
  });
});
