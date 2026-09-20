import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { decryptToken, generateEncryptionKey } from "../packages/control-plane/src/auth/crypto.ts";
import {
  BRAINTRUST_MCP_URL,
  PHONIC_DOCS_MCP_URL,
  buildSeedPlan,
  buildSeedSql,
  datadogMcpUrl,
  parseArgs,
  resolveEncryptionKey,
  run,
} from "./seed-integrations.ts";

const ENCRYPTION_KEY = generateEncryptionKey();

const FULL_ENV = {
  REPO_SECRETS_ENCRYPTION_KEY: ENCRYPTION_KEY,
  BRAINTRUST_API_KEY: "bt-key",
  DD_API_KEY: "dd-api",
  DD_APPLICATION_KEY: "dd-app",
  PHONIC_API_KEY: "ph-key",
};

/** Schema from terraform/d1/migrations 0004, 0018 and 0062. */
function createDatabase(): DatabaseSync {
  const database = new DatabaseSync(":memory:");
  database.exec(`
    CREATE TABLE global_secrets (
      key             TEXT    NOT NULL PRIMARY KEY,
      encrypted_value TEXT    NOT NULL,
      created_at      INTEGER NOT NULL,
      updated_at      INTEGER NOT NULL
    );
    CREATE TABLE mcp_servers (
      id         TEXT PRIMARY KEY,
      name       TEXT NOT NULL,
      type       TEXT NOT NULL CHECK(type IN ('local', 'remote')),
      command    TEXT,
      url        TEXT,
      env        TEXT NOT NULL DEFAULT '{}',
      repo_scope TEXT,
      enabled    INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      revision   INTEGER NOT NULL DEFAULT 1,
      CHECK((type = 'local' AND command IS NOT NULL) OR (type = 'remote' AND url IS NOT NULL))
    );
    CREATE UNIQUE INDEX idx_mcp_servers_name ON mcp_servers(name);
  `);
  return database;
}

interface McpRow {
  id: string;
  name: string;
  type: string;
  command: string | null;
  url: string;
  env: string;
  repo_scope: string | null;
  enabled: number;
  revision: number;
  updated_at: number;
}

function mcpRow(database: DatabaseSync, name: string): McpRow {
  const row = database.prepare("SELECT * FROM mcp_servers WHERE name = ?").get(name);
  assert.ok(row, `no mcp_servers row named ${name}`);
  return row as unknown as McpRow;
}

describe("parseArgs", () => {
  it("requires --database and defaults to dry run", () => {
    assert.deepEqual(parseArgs(["--database", "oi-db"]), { database: "oi-db", execute: false });
    assert.deepEqual(parseArgs(["--database", "oi-db", "--execute"]), {
      database: "oi-db",
      execute: true,
    });
    assert.throws(() => parseArgs([]), /--database is required/);
    assert.throws(() => parseArgs(["--database"]), /Missing value/);
    assert.throws(() => parseArgs(["--database", "x", "--bogus"]), /Unknown option/);
  });
});

describe("resolveEncryptionKey", () => {
  it("accepts the Doppler name or the TF_VAR alias exported by deploy.sh run", () => {
    assert.equal(resolveEncryptionKey({ REPO_SECRETS_ENCRYPTION_KEY: "a" }), "a");
    assert.equal(resolveEncryptionKey({ TF_VAR_repo_secrets_encryption_key: "b" }), "b");
    assert.throws(() => resolveEncryptionKey({}), /REPO_SECRETS_ENCRYPTION_KEY/);
  });
});

describe("buildSeedPlan", () => {
  it("seeds all three integrations when every credential is present", () => {
    const plan = buildSeedPlan(FULL_ENV);
    assert.deepEqual(
      plan.mcpServers.map((s) => s.name),
      ["braintrust", "datadog", "phonic-docs"]
    );
    assert.deepEqual(plan.mcpServers[0], {
      name: "braintrust",
      url: BRAINTRUST_MCP_URL,
      headers: { Authorization: "Bearer bt-key" },
    });
    assert.deepEqual(plan.mcpServers[1], {
      name: "datadog",
      url: "https://mcp.datadoghq.com/v1/mcp?toolsets=all",
      headers: { DD_API_KEY: "dd-api", DD_APPLICATION_KEY: "dd-app" },
    });
    assert.deepEqual(plan.mcpServers[2], {
      name: "phonic-docs",
      url: PHONIC_DOCS_MCP_URL,
      headers: {},
    });
    assert.deepEqual(plan.globalSecrets, {
      BRAINTRUST_API_KEY: "bt-key",
      PHONIC_API_KEY: "ph-key",
    });
    assert.deepEqual(plan.skipped, []);
  });

  it("skips integrations whose credentials are absent and reports them", () => {
    const plan = buildSeedPlan({ PHONIC_API_KEY: "ph-key", BRAINTRUST_API_KEY: "  " });
    assert.deepEqual(
      plan.mcpServers.map((s) => s.name),
      ["phonic-docs"]
    );
    assert.deepEqual(plan.globalSecrets, { PHONIC_API_KEY: "ph-key" });
    assert.equal(plan.skipped.length, 2);
    assert.match(plan.skipped[0], /braintrust/);
    assert.match(plan.skipped[1], /datadog/);
  });

  it("rejects a half-configured Datadog pair", () => {
    assert.throws(() => buildSeedPlan({ DD_API_KEY: "x" }), /DD_APPLICATION_KEY/);
  });

  it("honours regional and toolset overrides", () => {
    const plan = buildSeedPlan({
      DD_API_KEY: "a",
      DD_APPLICATION_KEY: "b",
      DD_SITE: "us5.datadoghq.com",
      DD_MCP_TOOLSETS: "apm,logs",
      BRAINTRUST_API_KEY: "k",
      BRAINTRUST_MCP_URL: "https://api-eu.braintrust.dev/mcp",
    });
    assert.equal(plan.mcpServers[0].url, "https://api-eu.braintrust.dev/mcp");
    assert.equal(
      plan.mcpServers[1].url,
      "https://mcp.us5.datadoghq.com/v1/mcp?toolsets=apm%2Clogs"
    );
    assert.equal(
      datadogMcpUrl("datadoghq.eu", "all"),
      "https://mcp.datadoghq.eu/v1/mcp?toolsets=all"
    );
  });
});

describe("buildSeedSql", () => {
  it("writes rows the control plane stores can decrypt", async () => {
    const database = createDatabase();
    const plan = buildSeedPlan(FULL_ENV);
    let counter = 0;
    const sql = await buildSeedSql(plan, ENCRYPTION_KEY, {
      generateId: () => `id${++counter}`,
      now: () => 1000,
    });
    database.exec(sql.join("\n"));

    const braintrust = mcpRow(database, "braintrust");
    assert.equal(braintrust.type, "remote");
    assert.equal(braintrust.command, null);
    assert.equal(braintrust.url, BRAINTRUST_MCP_URL);
    assert.equal(braintrust.enabled, 1);
    assert.equal(braintrust.repo_scope, null);
    assert.equal(braintrust.revision, 1);
    assert.deepEqual(JSON.parse(await decryptToken(braintrust.env, ENCRYPTION_KEY)), {
      Authorization: "Bearer bt-key",
    });

    const datadog = mcpRow(database, "datadog");
    assert.deepEqual(JSON.parse(await decryptToken(datadog.env, ENCRYPTION_KEY)), {
      DD_API_KEY: "dd-api",
      DD_APPLICATION_KEY: "dd-app",
    });

    // Credential-free servers store the plaintext "{}" sentinel like McpServerStore.
    assert.equal(mcpRow(database, "phonic-docs").env, "{}");

    const secrets = database
      .prepare("SELECT key, encrypted_value FROM global_secrets ORDER BY key")
      .all() as Array<{ key: string; encrypted_value: string }>;
    assert.deepEqual(
      secrets.map((row) => row.key),
      ["BRAINTRUST_API_KEY", "PHONIC_API_KEY"]
    );
    assert.equal(await decryptToken(secrets[1].encrypted_value, ENCRYPTION_KEY), "ph-key");
    assert.ok(!sql.join("\n").includes("ph-key"), "plaintext must never appear in SQL");
  });

  it("re-running rotates credentials, bumps revision and preserves operator edits", async () => {
    const database = createDatabase();
    let counter = 0;
    const first = await buildSeedSql(buildSeedPlan(FULL_ENV), ENCRYPTION_KEY, {
      generateId: () => `first${++counter}`,
      now: () => 1000,
    });
    database.exec(first.join("\n"));
    database.exec(
      `UPDATE mcp_servers SET enabled = 0, repo_scope = '["acme/web"]' WHERE name = 'datadog'`
    );

    const rotated = { ...FULL_ENV, DD_APPLICATION_KEY: "dd-app-2" };
    const second = await buildSeedSql(buildSeedPlan(rotated), ENCRYPTION_KEY, {
      generateId: () => `second${++counter}`,
      now: () => 2000,
    });
    database.exec(second.join("\n"));

    const datadog = mcpRow(database, "datadog");
    assert.equal(datadog.id, "first2", "existing row is updated, not replaced");
    assert.equal(datadog.revision, 2);
    assert.equal(datadog.enabled, 0);
    assert.equal(datadog.repo_scope, '["acme/web"]');
    assert.equal(datadog.updated_at, 2000);
    assert.deepEqual(JSON.parse(await decryptToken(datadog.env, ENCRYPTION_KEY)), {
      DD_API_KEY: "dd-api",
      DD_APPLICATION_KEY: "dd-app-2",
    });
    assert.equal(
      (database.prepare("SELECT COUNT(*) AS n FROM mcp_servers").get() as { n: number }).n,
      3
    );
  });
});

describe("run", () => {
  it("dry run describes the plan without touching wrangler or printing values", async () => {
    const lines: string[] = [];
    let calls = 0;
    await run({ database: "oi-db", execute: false }, FULL_ENV, {
      runWrangler: () => {
        calls++;
        return "";
      },
      log: (line) => lines.push(line),
    });
    assert.equal(calls, 0);
    const output = lines.join("\n");
    assert.match(
      output,
      /braintrust -> https:\/\/api\.braintrust\.dev\/mcp \(headers: Authorization\)/
    );
    assert.match(output, /global_secrets upsert: PHONIC_API_KEY/);
    assert.match(output, /Dry run only/);
    for (const value of ["bt-key", "dd-api", "dd-app", "ph-key", ENCRYPTION_KEY]) {
      assert.ok(!output.includes(value), `output leaked ${value}`);
    }
  });

  it("execute sends one --command batch to the named database", async () => {
    const operations: Array<{ database: string; operation: readonly string[] }> = [];
    await run({ database: "oi-db", execute: true }, FULL_ENV, {
      runWrangler: (database, operation) => {
        operations.push({ database, operation });
        return "[]";
      },
      log: () => {},
    });
    assert.equal(operations.length, 1);
    assert.equal(operations[0].database, "oi-db");
    assert.equal(operations[0].operation[0], "--command");
    assert.match(operations[0].operation[1], /INSERT INTO mcp_servers/);
    assert.match(operations[0].operation[1], /INSERT INTO global_secrets/);
  });

  it("does nothing when no integration credentials are present", async () => {
    const lines: string[] = [];
    await run(
      { database: "oi-db", execute: true },
      { REPO_SECRETS_ENCRYPTION_KEY: ENCRYPTION_KEY },
      {
        runWrangler: () => {
          throw new Error("should not run");
        },
        log: (line) => lines.push(line),
      }
    );
    assert.match(lines.join("\n"), /Nothing to seed/);
  });
});
