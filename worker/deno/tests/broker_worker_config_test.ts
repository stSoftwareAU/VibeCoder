/** The worker receives behaviour settings without host credential material. */
import { assertEquals, assertThrows } from "@std/assert";
import { projectHostConfigForBrokeredWorker } from "../lib/broker_worker_config.ts";

Deno.test("broker projection retains worker behaviour and separates every declared host secret", () => {
  const raw = {
    repos: ["example/repo"],
    agent_provider: "claude",
    claude_timeout: 900,
    agent_provider_fallback: [],
    agent_transcript_enabled: true,
    phase_model_overrides: { issue: "opus" },
    gh_config_dir: "/private/gh",
    ssh_key_path: "/private/key",
    imgbb_api_key: "secret-image",
    github_app_id: "123",
    github_app_installation_id: "456",
    github_app_private_key_path: "/private/pem",
    pr_reviewer_app: { private_key: "secret-reviewer" },
    callbacks: { finish: "send secret-callback" },
    container_extension: { path: "/private/extension" },
    repo_config: {
      "example/repo": {
        nice: 2,
        skip_auto_merge: false,
        quality_credentials: {
          mint: "emit secret-mint",
          env: ["PRIVATE_TOKEN"],
        },
        pre_setup_command: "echo secret-setup",
        qualityCommand: "echo secret-quality",
      },
    },
  };
  const result = projectHostConfigForBrokeredWorker(raw);
  assertEquals(result.workerConfig, {
    repos: ["example/repo"],
    agent_provider: "claude",
    claude_timeout: 900,
    agent_provider_fallback: [],
    agent_transcript_enabled: true,
    phase_model_overrides: { issue: "opus" },
    repo_config: { "example/repo": { nice: 2, skip_auto_merge: false } },
  });
  for (
    const secret of ["secret-", "/private/", "PRIVATE_TOKEN", "github_app"]
  ) {
    assertEquals(JSON.stringify(result.workerConfig).includes(secret), false);
  }
  assertEquals(result.hostOnlyConfig.pr_reviewer_app, raw.pr_reviewer_app);
  assertEquals(result.hostOnlyConfig.repo_config, {
    "example/repo": {
      quality_credentials: raw.repo_config["example/repo"].quality_credentials,
      pre_setup_command: "echo secret-setup",
      qualityCommand: "echo secret-quality",
    },
  });
});

Deno.test("broker projection rejects unknown keys and nested credential-shaped values", () => {
  for (
    const raw of [
      { githubToken: "secret-value" },
      { agent_provider: { api_key: "secret-value" } },
      { repos: ["example/repo", { token: "secret-value" }] },
      { phase_model_overrides: { issue: { api_key: "secret-value" } } },
      { repo_config: { "example/repo": { credentials: "secret-value" } } },
      { repo_config: { "../private": { nice: 1 } } },
    ]
  ) {
    const error = assertThrows(
      () => projectHostConfigForBrokeredWorker(raw),
      Error,
    );
    assertEquals(error.message.includes("secret-value"), false);
  }
});

Deno.test("broker projection clones both outputs without retaining mutable aliases", () => {
  const raw = { repos: ["example/repo"], pr_reviewer_app: { token: "secret" } };
  const result = projectHostConfigForBrokeredWorker(raw);
  raw.repos.push("other/repo");
  raw.pr_reviewer_app.token = "changed";
  assertEquals(result.workerConfig.repos, ["example/repo"]);
  assertEquals(result.hostOnlyConfig.pr_reviewer_app, { token: "secret" });
  (result.workerConfig.repos as string[]).push("third/repo");
  assertEquals(raw.repos, ["example/repo", "other/repo"]);
});

Deno.test("broker projection refuses ambiguous JSON, executable getters and non-finite numbers", () => {
  let called = false;
  const getter = {
    get imgbb_api_key() {
      called = true;
      return "secret";
    },
  };
  const cyclic: Record<string, unknown> = {};
  cyclic.callbacks = cyclic;
  for (
    const raw of [
      null,
      [],
      "config",
      getter,
      cyclic,
      { claude_timeout: NaN },
      { claude_timeout: Infinity },
      { repos: undefined },
      { callbacks: new Date() },
      JSON.parse('{"__proto__":{"token":"secret"}}'),
      {
        repo_config: {
          "example/repo": { quality_credentials: {}, qualityCredentials: {} },
        },
      },
    ]
  ) assertThrows(() => projectHostConfigForBrokeredWorker(raw));
  assertEquals(called, false);
});

Deno.test("broker projection cannot accept future config keys without an explicit policy", () => {
  assertThrows(() =>
    projectHostConfigForBrokeredWorker({ future_provider: "secret" })
  );
  assertEquals(projectHostConfigForBrokeredWorker({}), {
    workerConfig: {},
    hostOnlyConfig: {},
  });
});

Deno.test("broker projection retains pre-flight shell commands only on the host for every supported alias", () => {
  for (const key of ["preFlight", "pre_flight", "pre-flight"]) {
    const commands = ["TOKEN=synthetic-secret run-check"];
    const result = projectHostConfigForBrokeredWorker({
      repo_config: { "example/repo": { [key]: commands } },
    });
    assertEquals(result.workerConfig, { repo_config: { "example/repo": {} } });
    assertEquals(result.hostOnlyConfig, {
      repo_config: { "example/repo": { [key]: commands } },
    });
  }
  assertThrows(() =>
    projectHostConfigForBrokeredWorker({
      repo_config: { "example/repo": { "pre-flight": [], preFlight: [] } },
    })
  );
});

Deno.test("broker projection preserves the configured Claude turn cap", () => {
  assertEquals(
    projectHostConfigForBrokeredWorker({ claude_max_turns: 37 }).workerConfig,
    { claude_max_turns: 37 },
  );
});
