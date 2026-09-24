import { describe, expect, it, vi } from "vitest";
import { loadSandboxDopplerSecrets } from "./doppler-secrets";

const config = {
  token: "server-only-token",
  repositories: "kaizen-automation/kaizen",
  environmentIds: "env-approved",
};
const target = { environmentId: null, repository: "kaizen-automation/kaizen" };

describe("launch-time Doppler secrets", () => {
  it("downloads fresh resolved values and excludes credentials and metadata", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        Response.json({
          APP_KEY: "first",
          DOPPLER_TOKEN: "legacy",
          DOPPLER_PROJECT: "sandbox",
          ALIAS: config.token,
        })
      )
      .mockResolvedValueOnce(Response.json({ APP_KEY: "rotated" }));
    expect(await loadSandboxDopplerSecrets(config, target, fetcher)).toEqual({ APP_KEY: "first" });
    expect(await loadSandboxDopplerSecrets(config, target, fetcher)).toEqual({
      APP_KEY: "rotated",
    });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(fetcher.mock.calls[0][1]).toMatchObject({
      headers: { Authorization: `Bearer ${config.token}` },
      redirect: "error",
    });
    expect(fetcher.mock.calls[0][1]?.signal).toBeInstanceOf(AbortSignal);
  });

  it("does not fetch for unrelated repositories or implicitly authorize environments", async () => {
    const fetcher = vi.fn<typeof fetch>();
    for (const other of [
      { environmentId: null, repository: "kaizen-automation/other" },
      { environmentId: null, repository: null },
      { environmentId: "env-unapproved", repository: target.repository },
    ])
      expect(await loadSandboxDopplerSecrets(config, other, fetcher)).toBeNull();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("supports explicitly authorized environment launches", async () => {
    expect(
      await loadSandboxDopplerSecrets(
        config,
        { environmentId: "env-approved", repository: null },
        vi.fn<typeof fetch>().mockResolvedValue(Response.json({ APP_KEY: "value" }))
      )
    ).toEqual({ APP_KEY: "value" });
  });

  it("fails closed when an authorized target has no token", async () => {
    await expect(
      loadSandboxDopplerSecrets({ repositories: config.repositories }, target)
    ).rejects.toThrow("token is not configured");
  });

  it.each([
    () => new Response("sensitive error body", { status: 401 }),
    () => new Response("not json"),
    () => Response.json(["secret"]),
    () => Response.json({ KEY: { nested: "secret" } }),
    () => Response.json({ PATH: "attacker-controlled" }),
    () => new Response("x".repeat(1_048_577)),
  ])("fails closed on invalid responses without leaking their contents", async (response) => {
    await expect(
      loadSandboxDopplerSecrets(config, target, vi.fn<typeof fetch>().mockResolvedValue(response()))
    ).rejects.toThrow(/^Unable to load sandbox secrets from Doppler$/);
  });

  it("redacts network and timeout errors", async () => {
    await expect(
      loadSandboxDopplerSecrets(
        config,
        target,
        vi.fn<typeof fetch>().mockRejectedValue(new Error(config.token))
      )
    ).rejects.toThrow(/^Unable to load sandbox secrets from Doppler$/);
  });
});
