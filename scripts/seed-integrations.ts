/**
 * Seed agent-facing integrations (MCP servers + global secrets) into remote D1
 * from environment variables, so Doppler stays the single source of truth for
 * credentials that would otherwise be pasted into Settings by hand.
 *
 * Values are encrypted locally with REPO_SECRETS_ENCRYPTION_KEY (the same key
 * the control plane uses), so only ciphertext is sent to D1.
 *
 * Dry-run (remote D1 by default; prints the plan, never values):
 *   deploy/doppler/deploy.sh run npm run integrations:seed -- --database <d1-name>
 *
 * Execute after reviewing the plan:
 *   deploy/doppler/deploy.sh run npm run integrations:seed -- --database <d1-name> --execute
 *
 * Inputs (all optional except the encryption key; missing ones are skipped):
 *   REPO_SECRETS_ENCRYPTION_KEY | TF_VAR_repo_secrets_encryption_key
 *   BRAINTRUST_API_KEY [BRAINTRUST_MCP_URL]         -> MCP "braintrust" + global secret
 *   DD_API_KEY + DD_APPLICATION_KEY [DD_SITE] [DD_MCP_TOOLSETS]
 *                                                   -> MCP "datadog" (headers only)
 *   PHONIC_API_KEY                                  -> MCP "phonic-docs" + global secret
 *
 * Wrangler uses the normal CLOUDFLARE_API_TOKEN/CLOUDFLARE_ACCOUNT_ID
 * environment variables or the credentials established by `wrangler login`.
 */

import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { encryptToken } from "../packages/control-plane/src/auth/crypto.ts";

const VALUE_OPTIONS = new Set(["database"]);
const FLAG_OPTIONS = new Set(["execute"]);

export const BRAINTRUST_MCP_URL = "https://api.braintrust.dev/mcp";
const DEFAULT_DD_SITE = "datadoghq.com";
const DEFAULT_DD_MCP_TOOLSETS = "all";
export const PHONIC_DOCS_MCP_URL = "https://docs.phonic.co/_mcp/server";

/** Validated command-line options. */
export interface SeedCliOptions {
  database: string;
  execute: boolean;
}

/** A remote MCP server to upsert by name. */
interface RemoteMcpServerSeed {
  name: string;
  url: string;
  headers: Record<string, string>;
}

/** Everything the seed will write, derived purely from the environment. */
export interface SeedPlan {
  mcpServers: RemoteMcpServerSeed[];
  globalSecrets: Record<string, string>;
  /** Human-readable reasons an integration was skipped. */
  skipped: string[];
}

/** Parse and validate command-line arguments. */
export function parseArgs(argv: string[]): SeedCliOptions {
  const values = new Map<string, string>();
  const flags = new Set<string>();

  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];
    if (!argument.startsWith("--")) throw new Error(`Unexpected argument: ${argument}`);
    const name = argument.slice(2);
    if (FLAG_OPTIONS.has(name)) {
      if (flags.has(name)) throw new Error(`Duplicate option: --${name}`);
      flags.add(name);
      continue;
    }
    if (!VALUE_OPTIONS.has(name)) throw new Error(`Unknown option: --${name}`);
    if (values.has(name)) throw new Error(`Duplicate option: --${name}`);
    const value = argv[++index];
    if (value === undefined || value.startsWith("--")) {
      throw new Error(`Missing value for --${name}`);
    }
    values.set(name, value);
  }

  const database = values.get("database");
  if (!database?.trim()) throw new Error("--database is required");

  return { database: database.trim(), execute: flags.has("execute") };
}

function nonEmpty(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const value = env[name]?.trim();
  return value ? value : undefined;
}

/** The encryption key under its Doppler name or the TF_VAR_* alias `deploy.sh run` exports. */
export function resolveEncryptionKey(env: NodeJS.ProcessEnv): string {
  const key =
    nonEmpty(env, "REPO_SECRETS_ENCRYPTION_KEY") ??
    nonEmpty(env, "TF_VAR_repo_secrets_encryption_key");
  if (!key) {
    throw new Error(
      "REPO_SECRETS_ENCRYPTION_KEY (or TF_VAR_repo_secrets_encryption_key) is required"
    );
  }
  return key;
}

/** Datadog's regional MCP endpoint for a `DD_SITE` such as `datadoghq.com` or `us5.datadoghq.com`. */
export function datadogMcpUrl(site: string, toolsets: string): string {
  const url = new URL(`https://mcp.${site}/v1/mcp`);
  url.searchParams.set("toolsets", toolsets);
  return url.toString();
}

/** Derive the seed plan from the environment. Pure: no I/O. */
export function buildSeedPlan(env: NodeJS.ProcessEnv): SeedPlan {
  const plan: SeedPlan = { mcpServers: [], globalSecrets: {}, skipped: [] };

  const braintrustKey = nonEmpty(env, "BRAINTRUST_API_KEY");
  if (braintrustKey) {
    plan.mcpServers.push({
      name: "braintrust",
      url: nonEmpty(env, "BRAINTRUST_MCP_URL") ?? BRAINTRUST_MCP_URL,
      headers: { Authorization: `Bearer ${braintrustKey}` },
    });
    plan.globalSecrets.BRAINTRUST_API_KEY = braintrustKey;
  } else {
    plan.skipped.push("braintrust: BRAINTRUST_API_KEY not set");
  }

  const ddApiKey = nonEmpty(env, "DD_API_KEY");
  const ddAppKey = nonEmpty(env, "DD_APPLICATION_KEY");
  if (ddApiKey && ddAppKey) {
    plan.mcpServers.push({
      name: "datadog",
      url: datadogMcpUrl(
        nonEmpty(env, "DD_SITE") ?? DEFAULT_DD_SITE,
        nonEmpty(env, "DD_MCP_TOOLSETS") ?? DEFAULT_DD_MCP_TOOLSETS
      ),
      headers: { DD_API_KEY: ddApiKey, DD_APPLICATION_KEY: ddAppKey },
    });
  } else if (ddApiKey || ddAppKey) {
    throw new Error("datadog: DD_API_KEY and DD_APPLICATION_KEY must both be set");
  } else {
    plan.skipped.push("datadog: DD_API_KEY / DD_APPLICATION_KEY not set");
  }

  const phonicKey = nonEmpty(env, "PHONIC_API_KEY");
  if (phonicKey) {
    plan.mcpServers.push({ name: "phonic-docs", url: PHONIC_DOCS_MCP_URL, headers: {} });
    plan.globalSecrets.PHONIC_API_KEY = phonicKey;
  } else {
    plan.skipped.push("phonic: PHONIC_API_KEY not set");
  }

  return plan;
}

function sqlLiteral(value: string | number): string {
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) throw new Error(`Unsafe SQL integer: ${value}`);
    return String(value);
  }
  return `'${value.replaceAll("'", "''")}'`;
}

function generateId(): string {
  return crypto.randomUUID().replace(/-/g, "").slice(0, 16);
}

/** Injectable side effects for deterministic tests. */
export interface SeedSqlDependencies {
  generateId?: () => string;
  now?: () => number;
}

/**
 * Build the upsert statements for a plan. Ciphertext matches what
 * McpServerStore / GlobalSecretsStore write, so the control plane reads the
 * rows exactly as if they had been created in Settings. Existing rows keep
 * their `enabled` and `repo_scope` (operator edits) and bump `revision`.
 */
export async function buildSeedSql(
  plan: SeedPlan,
  encryptionKey: string,
  dependencies: SeedSqlDependencies = {}
): Promise<string[]> {
  const now = dependencies.now?.() ?? Date.now();
  const newId = dependencies.generateId ?? generateId;
  const statements: string[] = [];

  for (const server of plan.mcpServers) {
    const headers = JSON.stringify(server.headers);
    const env =
      Object.keys(server.headers).length === 0
        ? headers
        : await encryptToken(headers, encryptionKey);
    statements.push(
      `INSERT INTO mcp_servers (id, name, type, command, url, env, repo_scope, enabled, created_at, updated_at)
VALUES (${sqlLiteral(newId())}, ${sqlLiteral(server.name)}, 'remote', NULL, ${sqlLiteral(server.url)}, ${sqlLiteral(env)}, NULL, 1, ${sqlLiteral(now)}, ${sqlLiteral(now)})
ON CONFLICT(name) DO UPDATE SET
  type = 'remote',
  command = NULL,
  url = excluded.url,
  env = excluded.env,
  revision = mcp_servers.revision + 1,
  updated_at = excluded.updated_at;`
    );
  }

  for (const [key, value] of Object.entries(plan.globalSecrets)) {
    const encrypted = await encryptToken(value, encryptionKey);
    statements.push(
      `INSERT INTO global_secrets (key, encrypted_value, created_at, updated_at)
VALUES (${sqlLiteral(key)}, ${sqlLiteral(encrypted)}, ${sqlLiteral(now)}, ${sqlLiteral(now)})
ON CONFLICT(key) DO UPDATE SET
  encrypted_value = excluded.encrypted_value,
  updated_at = excluded.updated_at;`
    );
  }

  return statements;
}

/** Runs one wrangler `d1 execute` and returns its stdout. */
type WranglerRunner = (database: string, operation: readonly string[]) => string;

function runWrangler(database: string, operation: readonly string[]): string {
  const child = spawnSync(
    "npx",
    ["wrangler", "d1", "execute", database, "--remote", ...operation, "--json"],
    { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 }
  );
  if (child.status !== 0) {
    throw new Error(`Integration seed failed:\n${child.stderr || child.stdout}`);
  }
  return child.stdout;
}

/** Injectable side effects for deterministic orchestration tests. */
export interface SeedRunDependencies extends SeedSqlDependencies {
  runWrangler?: WranglerRunner;
  log?: (line: string) => void;
}

function describePlan(plan: SeedPlan): string[] {
  const lines: string[] = [];
  for (const server of plan.mcpServers) {
    const headerKeys = Object.keys(server.headers);
    lines.push(
      `mcp_servers upsert: ${server.name} -> ${server.url}` +
        (headerKeys.length ? ` (headers: ${headerKeys.join(", ")})` : " (no headers)")
    );
  }
  for (const key of Object.keys(plan.globalSecrets)) {
    lines.push(`global_secrets upsert: ${key}`);
  }
  for (const reason of plan.skipped) lines.push(`skipped ${reason}`);
  return lines;
}

/** Run the seed: plan from `env`, dry-run by default, execute with `--execute`. */
export async function run(
  options: SeedCliOptions,
  env: NodeJS.ProcessEnv,
  dependencies: SeedRunDependencies = {}
): Promise<void> {
  const log = dependencies.log ?? ((line: string) => console.error(line));
  const runner = dependencies.runWrangler ?? runWrangler;
  const encryptionKey = resolveEncryptionKey(env);
  const plan = buildSeedPlan(env);

  log(`${options.execute ? "Executing" : "Dry-running"} integration seed on remote D1...`);
  for (const line of describePlan(plan)) log(line);

  if (plan.mcpServers.length === 0 && Object.keys(plan.globalSecrets).length === 0) {
    log("Nothing to seed.");
    return;
  }
  if (!options.execute) {
    log("Dry run only. Re-run with --execute to apply.");
    return;
  }

  const statements = await buildSeedSql(plan, encryptionKey, dependencies);
  runner(options.database, ["--command", statements.join("\n")]);
  log(
    `Seeded ${plan.mcpServers.length} MCP server(s) and ${Object.keys(plan.globalSecrets).length} global secret(s); verify in Settings.`
  );
}

async function main(): Promise<void> {
  await run(parseArgs(process.argv.slice(2)), process.env);
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : null;
if (invokedPath === import.meta.url) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
