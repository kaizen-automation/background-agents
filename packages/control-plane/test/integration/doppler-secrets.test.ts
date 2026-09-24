import { describe, expect, it } from "vitest";
import { loadSandboxDopplerSecrets } from "../../src/session/doppler-secrets";

const target = { repository: "kaizen-automation/kaizen", environmentId: null };
const config = { repositories: target.repository, token: "integration-doppler" };

describe("Doppler fetch in workerd", () => {
  it("uses the real runtime fetch and strips credentials", async () => {
    await expect(loadSandboxDopplerSecrets(config, target)).resolves.toEqual({
      APP_KEY: "synthetic-value",
    });
  });
  it("rejects redirects without following them", async () => {
    await expect(
      loadSandboxDopplerSecrets({ ...config, token: "integration-doppler-redirect" }, target)
    ).rejects.toThrow("Unable to load sandbox secrets from Doppler");
  });
});
