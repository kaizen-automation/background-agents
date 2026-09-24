// Execute the real wrapper against synthetic secrets and recording CLI doubles.
// No inherited credentials, real Doppler calls, worker builds, or Terraform applies.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const required = [
  "CLOUDFLARE_ACCOUNT_ID",
  "CLOUDFLARE_API_TOKEN",
  "CLOUDFLARE_ZONE_ID",
  "CLOUDFLARE_WORKER_SUBDOMAIN",
  "CLOUDFLARE_CUSTOM_DOMAIN",
  "R2_ACCESS_KEY_ID",
  "R2_SECRET_ACCESS_KEY",
  "MODAL_TOKEN_ID",
  "MODAL_TOKEN_SECRET",
  "MODAL_WORKSPACE",
  "GITHUB_APP_ID",
  "GITHUB_APP_PRIVATE_KEY",
  "GITHUB_APP_INSTALLATION_ID",
  "GITHUB_CLIENT_ID",
  "GITHUB_CLIENT_SECRET",
  "NEXTAUTH_SECRET",
  "TOKEN_ENCRYPTION_KEY",
  "REPO_SECRETS_ENCRYPTION_KEY",
  "PROVIDER_ACCOUNTS_ENCRYPTION_KEY",
  "MODAL_API_SECRET",
  "ALLOWED_GITHUB_ORGS",
];
const fixture = Object.fromEntries(required.map((name) => [name, `synthetic-${name}`]));
fixture.GITHUB_APP_PRIVATE_KEY = "synthetic key with spaces\nsecond line $literal";
Object.assign(fixture, {
  AWS_BEARER_TOKEN_BEDROCK: "synthetic-bedrock",
  AWS_REGION: "us-west-2",
  AZURE_OPENAI_API_KEY: "synthetic-azure",
  SANDBOX_DOPPLER_TOKEN: "synthetic-sandbox",
  ANTHROPIC_API_KEY: "",
});

const cli = `#!${process.execPath}
const fs = require('node:fs');
const {basename} = require('node:path');
const {spawnSync} = require('node:child_process');
const name = basename(process.argv[1]);
const args = process.argv.slice(2);
fs.appendFileSync(process.env.CALLS, JSON.stringify({name,args,cwd:process.cwd(),env:process.env})+'\\n');
if (process.env.FAIL_TOOL === name || (process.env.FAIL_TOOL === 'workers' && name === 'npm' && args.includes('@open-inspect/control-plane'))) process.exit(23);
if (name === 'doppler') {
  const expected = ['run','--no-fallback','--project','kaizen-code','--config','prd','--'];
  if (JSON.stringify(args.slice(0,7)) !== JSON.stringify(expected)) process.exit(64);
  const secrets = JSON.parse(fs.readFileSync(process.env.FIXTURE,'utf8'));
  const result = spawnSync(args[7],args.slice(8),{env:{...process.env,...secrets},stdio:'inherit'});
  process.exit(result.status ?? 70);
}
if (!['npm','terraform'].includes(name)) process.exit(65);
`;

function run(t, args, { secrets = fixture, fail = "", token = "synthetic-deployment-token" } = {}) {
  const root = mkdtempSync(join(tmpdir(), "deploy-wrapper-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const bin = join(root, "bin");
  mkdirSync(bin);
  mkdirSync(join(root, "deploy/doppler"), { recursive: true });
  mkdirSync(join(root, "terraform/environments/production"), { recursive: true });
  const script = join(root, "deploy/doppler/deploy.sh");
  copyFileSync(new URL("../deploy/doppler/deploy.sh", import.meta.url), script);
  chmodSync(script, 0o755);
  const vars = join(root, "deploy/production.tfvars.json");
  writeFileSync(vars, '{"deployment_name":"synthetic"}');
  const calls = join(root, "calls.jsonl");
  writeFileSync(calls, "");
  const fixtures = join(root, "fixture.json");
  writeFileSync(fixtures, JSON.stringify(secrets));
  for (const tool of ["doppler", "terraform", "npm", "uv", "jq", "curl"]) {
    writeFileSync(join(bin, tool), cli, { mode: 0o755 });
  }
  // Allow only execution plumbing from the host; never inherit its credentials.
  const result = spawnSync("bash", [script, ...args], {
    env: {
      PATH: `${bin}:${process.env.PATH}`,
      HOME: root,
      CALLS: calls,
      FIXTURE: fixtures,
      FAIL_TOOL: fail,
      DOPPLER_TOKEN: token,
    },
    encoding: "utf8",
    timeout: 15000,
  });
  assert.ifError(result.error);
  const records = readFileSync(calls, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse);
  for (const value of [token, ...Object.values(secrets)].filter(Boolean)) {
    assert.ok(!(result.stdout + result.stderr).includes(value), "secret leaked to output");
    assert.ok(
      !records.some(({ args }) => args.some((arg) => arg.includes(value))),
      "secret leaked to argv"
    );
  }
  return { ...result, records, root, vars };
}

function terraform(result) {
  assert.equal(result.status, 0, result.stderr);
  const call = result.records.find((r) => r.name === "terraform");
  assert.ok(call, "Terraform must execute");
  return call;
}

test("maps synthetic secrets into Terraform, backend, and CLI environments", (t) => {
  const result = run(t, ["init"]);
  const call = terraform(result);
  for (const name of required.filter((n) => !n.startsWith("R2_"))) {
    assert.equal(call.env[`TF_VAR_${name.toLowerCase()}`], fixture[name], name);
  }
  for (const name of [
    "AWS_BEARER_TOKEN_BEDROCK",
    "AWS_REGION",
    "AZURE_OPENAI_API_KEY",
    "SANDBOX_DOPPLER_TOKEN",
  ]) {
    assert.equal(call.env[`TF_VAR_${name.toLowerCase()}`], fixture[name]);
  }
  assert.equal(call.env.TF_VAR_anthropic_api_key, undefined);
  assert.equal(call.env.AWS_ACCESS_KEY_ID, fixture.R2_ACCESS_KEY_ID);
  assert.equal(call.env.AWS_SECRET_ACCESS_KEY, fixture.R2_SECRET_ACCESS_KEY);
  assert.equal(
    call.env.AWS_ENDPOINT_URL_S3,
    `https://${fixture.CLOUDFLARE_ACCOUNT_ID}.r2.cloudflarestorage.com`
  );
  assert.equal(call.env.AWS_REGION, "auto");
  for (const name of [
    "CLOUDFLARE_API_TOKEN",
    "CLOUDFLARE_ACCOUNT_ID",
    "MODAL_TOKEN_ID",
    "MODAL_TOKEN_SECRET",
  ]) {
    assert.equal(call.env[name], fixture[name]);
  }
  for (const name of [
    "R2_ACCESS_KEY_ID",
    "R2_SECRET_ACCESS_KEY",
    "GITHUB_APP_PRIVATE_KEY",
    "AWS_BEARER_TOKEN_BEDROCK",
    "SANDBOX_DOPPLER_TOKEN",
  ]) {
    assert.equal(call.env[name], undefined);
  }
  assert.equal(call.env.TF_IN_AUTOMATION, "1");
  assert.equal(call.env.WRANGLER_SEND_METRICS, "false");
  assert.deepEqual(call.args, [
    `-chdir=${result.root}/terraform/environments/production`,
    "init",
    "-reconfigure",
    "-input=false",
  ]);
  assert.deepEqual(
    result.records.map((r) => r.name),
    ["doppler", "terraform"]
  );
});

for (const command of ["plan", "apply"]) {
  for (const phase of ["1", "2"]) {
    test(`${command} phase ${phase} builds shared before workers and forwards arguments`, (t) => {
      const result = run(t, [command, phase, "-no-color", "-lock-timeout=30s"]);
      const call = terraform(result);
      assert.deepEqual(
        result.records.map((r) => r.name),
        ["doppler", "npm", "npm", "terraform"]
      );
      const builds = result.records.filter((r) => r.name === "npm");
      assert.deepEqual(builds[0].args, ["run", "build", "-w", "@open-inspect/shared"]);
      assert.deepEqual(builds[1].args, [
        "run",
        "build",
        "-w",
        "@open-inspect/control-plane",
        "-w",
        "@open-inspect/slack-bot",
        "-w",
        "@open-inspect/github-bot",
        "-w",
        "@open-inspect/linear-bot",
      ]);
      assert.ok(builds.every((r) => r.cwd === result.root));
      assert.deepEqual(call.args, [
        `-chdir=${result.root}/terraform/environments/production`,
        command,
        "-input=false",
        `-var-file=${result.vars}`,
        "-var",
        `enable_durable_object_bindings=${phase === "2"}`,
        "-var",
        `enable_service_bindings=${phase === "2"}`,
        "-no-color",
        "-lock-timeout=30s",
      ]);
    });
  }
}

test("apply defaults to phase two", (t) => {
  const call = terraform(run(t, ["apply"]));
  assert.ok(call.args.includes("enable_durable_object_bindings=true"));
  assert.ok(call.args.includes("enable_service_bindings=true"));
});

for (const tool of ["doppler", "npm", "terraform"]) {
  test(`${tool} failure propagates and stops deployment`, (t) => {
    const result = run(t, ["apply", "2", "-auto-approve"], { fail: tool });
    assert.equal(result.status, 23, result.stderr);
    assert.equal(result.records.at(-1).name, tool);
    if (tool !== "terraform") assert.ok(!result.records.some((r) => r.name === "terraform"));
  });
}

test("missing deployment token prevents any external command", (t) => {
  const result = run(t, ["apply"], { token: "" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /DOPPLER_TOKEN is not set/);
  assert.deepEqual(result.records, []);
});

test("missing required secret fails before builds or apply", (t) => {
  const result = run(t, ["apply"], { secrets: { ...fixture, GITHUB_APP_PRIVATE_KEY: "" } });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /required Doppler secret GITHUB_APP_PRIVATE_KEY is empty/);
  assert.deepEqual(
    result.records.map((r) => r.name),
    ["doppler"]
  );
});

test("worker build failure prevents Terraform apply after shared succeeds", (t) => {
  const result = run(t, ["apply", "2", "-auto-approve"], { fail: "workers" });
  assert.equal(result.status, 23, result.stderr);
  assert.deepEqual(
    result.records.map((r) => r.name),
    ["doppler", "npm", "npm"]
  );
});
