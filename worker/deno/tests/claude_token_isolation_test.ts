/**
 * Only the selected Claude token reaches the agent subprocess (Issue #920).
 *
 * A host may now hold several Claude subscriptions as separate credential
 * files — `claude/provider.env`, `claude/provider-2.env`, … — of which a run
 * selects exactly one (`credential_preflight.ts` discovers them,
 * `claude_token_selection.ts` chooses). The agent subprocess runs
 * `--dangerously-skip-permissions`, so anything in its environment is
 * something a compromised or merely careless run can spend or exfiltrate. An
 * unselected token in that environment is a subscription the operator never
 * put in play for this run: the blast radius of one bad run becomes every
 * token on the host.
 *
 * The environment is closed by two rules working together, and these tests
 * pin both:
 *
 *   1. Exactly one token file is exported into the worker's own environment,
 *      so only one Anthropic credential exists to inherit.
 *   2. Each vendor's secret allowlist exempts the base credential names and
 *      ONLY those. A suffixed or indexed variant — `CLAUDE_CODE_OAUTH_TOKEN_2`
 *      — is a different credential wearing a familiar prefix, and is denied by
 *      an explicit rule in `agent_env.ts`. Every such variant happens to also
 *      match the credential-shape pattern today, which is precisely why the
 *      rule is stated rather than assumed: the guarantee must not evaporate
 *      the day somebody narrows that pattern. One test below proves the
 *      denial with the shape rule switched off, so it cannot pass by accident.
 *
 * What these tests do NOT claim: that an unselected token is unreadable from
 * inside the container. The provider's whole credential sub-directory is
 * mounted read-only, so a process with filesystem read access there can read
 * every token file — the same exposure a single-token host has always carried,
 * with a higher count. That is accepted and recorded (R9 in the threat model),
 * and the last test holds the record in place rather than letting the risk go
 * unwritten. Isolating the mount is separate work.
 *
 * Uses Australian English spelling (behaviour, colour, organisation, etc.)
 */

import { assert, assertEquals } from "@std/assert";
import {
  APPROVAL_STATE_VOLUME_NAME,
  buildContainerLaunchPlan,
  type ContainerLaunchInputs,
} from "../lib/container_launch.ts";
import {
  type ContainerManifest,
  parseContainerManifest,
} from "../lib/container_manifest.ts";
import {
  CONTAINER_RUNTIMES,
  type ContainerRuntimeDescriptor,
} from "../lib/container_runtime.ts";
import { isDeniedAgentEnvVar } from "../lib/agent_env.ts";
import {
  buildClaudeChildEnv,
  CLAUDE_CREDENTIAL_ENV_VARS,
  CLAUDE_ENV_DENYLIST,
  CLAUDE_ENV_SECRET_ALLOWLIST,
  isDeniedClaudeEnvVar,
} from "../lib/claude_env.ts";
import { buildCodexChildEnv, CODEX_ENV_DENYLIST } from "../lib/codex_env.ts";
import { buildGeminiChildEnv, GEMINI_ENV_DENYLIST } from "../lib/gemini_env.ts";
import {
  buildDeepSeekChildEnv,
  DEEPSEEK_ENV_DENYLIST,
} from "../lib/deepseek_env.ts";
import {
  applyProviderCredentialEnv,
  discoverProviderTokenFiles,
} from "../lib/credential_preflight.ts";
import { resolveAgentProvider } from "../lib/agent_provider.ts";

/** The three token values a pooled host holds; the second is the selected one. */
const TOKEN_ONE = "sk-ant-oat01-unselected-first";
const TOKEN_TWO = "sk-ant-oat01-selected-second";
const TOKEN_THREE = "sk-ant-oat01-unselected-third";

/** The Claude provider descriptor, with its real pool configuration. */
const CLAUDE = resolveAgentProvider("claude");

/** Names in `env` that carry, or could carry, an Anthropic credential. */
function anthropicNames(env: Record<string, string>): string[] {
  return Object.keys(env)
    .filter((name) => /^(ANTHROPIC_|CLAUDE_CODE_)/.test(name))
    .sort();
}

/** Values in `env` that contain any of `needles`, for leak assertions. */
function leaks(
  env: Record<string, string>,
  needles: readonly string[],
): string[] {
  return Object.entries(env)
    .filter(([, value]) => needles.some((needle) => value.includes(needle)))
    .map(([name]) => name)
    .sort();
}

/** A pooled credential directory: three token files, plus the `gh` material. */
async function pooledCredentialDir(): Promise<string> {
  const dir = await Deno.makeTempDir();
  await Deno.mkdir(`${dir}/gh`, { recursive: true });
  await Deno.mkdir(`${dir}/claude`, { recursive: true });
  await Deno.writeTextFile(
    `${dir}/claude/provider.env`,
    `CLAUDE_CODE_OAUTH_TOKEN=${TOKEN_ONE}\n`,
  );
  await Deno.writeTextFile(
    `${dir}/claude/provider-2.env`,
    `CLAUDE_CODE_OAUTH_TOKEN=${TOKEN_TWO}\n`,
  );
  await Deno.writeTextFile(
    `${dir}/claude/provider-3.env`,
    `CLAUDE_CODE_OAUTH_TOKEN=${TOKEN_THREE}\n`,
  );
  return dir;
}

// ---------------------------------------------------------------------------
// The environment the agent subprocess receives
// ---------------------------------------------------------------------------

Deno.test("buildClaudeChildEnv - exactly one Anthropic credential survives, the selected token's (Issue #920)", () => {
  // The parent environment of a pooled host that has gone wrong in the most
  // ordinary way: the operator parked the other subscriptions in numbered
  // variables beside the one the run exported.
  const child = buildClaudeChildEnv({
    PATH: "/usr/bin",
    HOME: "/home/vibe",
    GH_TOKEN: "ghs_installationtoken",
    CLAUDE_CODE_OAUTH_TOKEN: TOKEN_TWO,
    CLAUDE_CODE_OAUTH_TOKEN_1: TOKEN_ONE,
    CLAUDE_CODE_OAUTH_TOKEN_3: TOKEN_THREE,
    ANTHROPIC_API_KEY_BACKUP: TOKEN_ONE,
    ANTHROPIC_AUTH_TOKEN_OLD: TOKEN_THREE,
  });

  assertEquals(anthropicNames(child), ["CLAUDE_CODE_OAUTH_TOKEN"]);
  assertEquals(child["CLAUDE_CODE_OAUTH_TOKEN"], TOKEN_TWO);
  // Not merely absent under those names — absent as values, wherever parked.
  assertEquals(leaks(child, [TOKEN_ONE, TOKEN_THREE]), []);
  // The child is still usable: the work it legitimately does is untouched.
  assertEquals(child["GH_TOKEN"], "ghs_installationtoken");
  assertEquals(child["PATH"], "/usr/bin");
});

Deno.test("isDeniedClaudeEnvVar - every suffixed and indexed variant of an accepted credential name is denied (Issue #920)", () => {
  for (const base of CLAUDE_CREDENTIAL_ENV_VARS) {
    // The base name is the one credential the child legitimately needs.
    assertEquals(isDeniedClaudeEnvVar(base), false, `${base} must be allowed`);
    for (const suffix of ["_2", "2", "_10", "_SECONDARY", "-BACKUP", "_OLD"]) {
      assertEquals(
        isDeniedClaudeEnvVar(`${base}${suffix}`),
        true,
        `${base}${suffix} must be denied`,
      );
    }
  }
});

Deno.test("isDeniedAgentEnvVar - the variant denial survives a credential-shape rule that matches nothing (Issue #920)", () => {
  // The point of the explicit rule. Every variant of an Anthropic credential
  // name contains TOKEN or API_KEY, so the shape pattern denies them all
  // today — by accident of its wording, not by decision. Narrow the pattern to
  // nothing and the decision must still stand, otherwise the guarantee is one
  // regex edit away from handing the agent a second subscription.
  const neverMatches = /(?!)/;
  const policy = {
    denylist: CLAUDE_ENV_DENYLIST,
    secretAllowlist: CLAUDE_ENV_SECRET_ALLOWLIST,
    secretNamePattern: neverMatches,
  };

  assertEquals(isDeniedAgentEnvVar("CLAUDE_CODE_OAUTH_TOKEN_2", policy), true);
  assertEquals(isDeniedAgentEnvVar("ANTHROPIC_API_KEY_2", policy), true);
  assertEquals(isDeniedAgentEnvVar("ANTHROPIC_AUTH_TOKEN_2", policy), true);
  // A cross-vendor credential's variant too: the denylist half of the rule.
  assertEquals(isDeniedAgentEnvVar("DEEPSEEK_API_KEY_2", policy), true);
  // The selected credential and the child's ordinary variables are unaffected.
  assertEquals(isDeniedAgentEnvVar("CLAUDE_CODE_OAUTH_TOKEN", policy), false);
  assertEquals(isDeniedAgentEnvVar("PATH", policy), false);
});

Deno.test("CLAUDE_ENV_SECRET_ALLOWLIST - exempts the accepted credential names and nothing Anthropic-shaped beyond them (Issue #920)", () => {
  // The allowlist is the only way out of the denial, so what it exempts is
  // the whole attack surface for this issue: it must be the exact names the
  // provider descriptor accepts in a credential file, not a prefix of them.
  assertEquals(
    CLAUDE_ENV_SECRET_ALLOWLIST.filter((name) =>
      /^(ANTHROPIC_|CLAUDE_)/.test(name)
    ),
    [...CLAUDE_CREDENTIAL_ENV_VARS],
  );
  assertEquals(
    [...CLAUDE_CREDENTIAL_ENV_VARS].sort(),
    [...CLAUDE.credentials.envVars].sort(),
  );
});

Deno.test("the other vendors' denylists name every Anthropic credential, so no allowlist can exempt one (Issue #920)", () => {
  // The denylist is checked before the secret allowlist, so naming the
  // Anthropic credentials there is what makes the cross-vendor withholding
  // survive a future edit that allowlists a secret-shaped name. Without these
  // entries the denial would rest entirely on the shape pattern — which the
  // vendor's own allowlist is allowed to override.
  for (const name of CLAUDE_CREDENTIAL_ENV_VARS) {
    assert(CODEX_ENV_DENYLIST.includes(name), `codex must deny ${name}`);
    assert(GEMINI_ENV_DENYLIST.includes(name), `gemini must deny ${name}`);
    assert(DEEPSEEK_ENV_DENYLIST.includes(name), `deepseek must deny ${name}`);
  }
});

Deno.test("the other vendors' children receive no Claude token, selected or pooled (Issue #920)", () => {
  // A `claude,codex` run exports Claude's selected token into the worker's own
  // environment, so every other vendor's child is built from a parent that
  // holds it. None of them may inherit it — and none of them may inherit an
  // unselected one either.
  const parent = {
    PATH: "/usr/bin",
    HOME: "/home/vibe",
    GH_TOKEN: "ghs_installationtoken",
    CLAUDE_CODE_OAUTH_TOKEN: TOKEN_TWO,
    CLAUDE_CODE_OAUTH_TOKEN_2: TOKEN_ONE,
    ANTHROPIC_API_KEY: TOKEN_ONE,
    ANTHROPIC_API_KEY_2: TOKEN_THREE,
    ANTHROPIC_AUTH_TOKEN_2: TOKEN_THREE,
    OPENAI_API_KEY: "sk-openai",
    GEMINI_API_KEY: "gemini-key",
    DEEPSEEK_API_KEY: "sk-deepseek",
  };
  const anthropicValues = [TOKEN_ONE, TOKEN_TWO, TOKEN_THREE];

  const codex = buildCodexChildEnv(parent);
  assertEquals(anthropicNames(codex), []);
  assertEquals(leaks(codex, anthropicValues), []);
  assertEquals(codex["OPENAI_API_KEY"], "sk-openai");

  const gemini = buildGeminiChildEnv(parent);
  assertEquals(anthropicNames(gemini), []);
  assertEquals(leaks(gemini, anthropicValues), []);
  assertEquals(gemini["GEMINI_API_KEY"], "gemini-key");

  // DeepSeek runs on Anthropic's CLI, so ANTHROPIC_AUTH_TOKEN is set for it —
  // but from DeepSeek's own key, never inherited (Issue #414). No Anthropic
  // value reaches it, pooled or selected.
  const deepseek = buildDeepSeekChildEnv(parent);
  assertEquals(deepseek["ANTHROPIC_AUTH_TOKEN"], "sk-deepseek");
  assertEquals(deepseek["ANTHROPIC_API_KEY"], undefined);
  assertEquals(deepseek["CLAUDE_CODE_OAUTH_TOKEN"], undefined);
  assertEquals(leaks(deepseek, anthropicValues), []);
});

// ---------------------------------------------------------------------------
// Selection to subprocess, end to end
// ---------------------------------------------------------------------------

Deno.test("three token files, the second selected: the agent child receives that token and no trace of the others (Issue #920)", async () => {
  const dir = await pooledCredentialDir();
  try {
    const tokens = await discoverProviderTokenFiles(dir, CLAUDE);
    assertEquals(tokens.map((token) => token.label), [
      "provider",
      "provider-2",
      "provider-3",
    ]);

    // The worker's own environment, never the process's (this file stays
    // parallel-safe: nothing here touches Deno.env).
    const workerEnv: Record<string, string> = {
      PATH: "/usr/bin",
      HOME: "/home/vibe",
      GH_TOKEN: "ghs_installationtoken",
      VIBE_IMAGE_AGENT_PROVIDERS: "claude",
      WORK_DIR: "/home/vibe/auto-issue-work",
    };
    const exported = await applyProviderCredentialEnv({
      dir,
      providers: [CLAUDE],
      env: (name) => workerEnv[name],
      setEnv: (name, value) => {
        workerEnv[name] = value;
      },
      // #919's budget selector, standing in for whatever it picks today.
      selectToken: (candidates) =>
        candidates.find((token) => token.label === "provider-2") ?? null,
    });

    assertEquals(exported, ["CLAUDE_CODE_OAUTH_TOKEN"]);
    // One token in the worker, so one token to inherit.
    assertEquals(anthropicNames(workerEnv), ["CLAUDE_CODE_OAUTH_TOKEN"]);
    assertEquals(leaks(workerEnv, [TOKEN_ONE, TOKEN_THREE]), []);

    const child = buildClaudeChildEnv(workerEnv);
    assertEquals(anthropicNames(child), ["CLAUDE_CODE_OAUTH_TOKEN"]);
    assertEquals(child["CLAUDE_CODE_OAUTH_TOKEN"], TOKEN_TWO);
    assertEquals(leaks(child, [TOKEN_ONE, TOKEN_THREE]), []);
    // No variable hands the child a path to the pool either — knowing where
    // the unselected files live is the first half of reading them.
    assertEquals(leaks(child, [dir, "provider-2.env", "provider-3.env"]), []);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

// ---------------------------------------------------------------------------
// The filesystem view: what the container hands over, and what it does not
// ---------------------------------------------------------------------------

/** The repository's real manifest — the source of the in-container layout. */
const MANIFEST: ContainerManifest = parseContainerManifest(
  await Deno.readTextFile(
    new URL("../../../container/tools.json", import.meta.url),
  ),
);

function dockerDescriptor(): ContainerRuntimeDescriptor {
  const candidate = CONTAINER_RUNTIMES["docker"];
  return {
    platform: "linux",
    kind: "docker",
    executable: candidate.executable,
    displayName: candidate.displayName,
    dialect: candidate.dialect,
    probed: ["docker"],
  };
}

function launchInputs(credentialDir: string): ContainerLaunchInputs {
  return {
    descriptor: dockerDescriptor(),
    manifest: MANIFEST,
    image: "vibe-coder:0123456789ab",
    containerName: "vibe-coder-920",
    watchdogSeconds: 11_400,
    hostPaths: {
      homeDir: "/home/operator",
      baseDir: "/opt/VibeCoder",
      workDir: "/home/operator/auto-issue-work",
      logDir: "/home/operator/logs",
      configFile: "/opt/VibeCoder/.config.json",
      configStageDir: "/home/operator/.vibe-coder/run-config",
      credentialDir,
    },
  };
}

Deno.test("buildContainerLaunchPlan - no token value or unselected token path reaches the container invocation (Issue #920)", async () => {
  const dir = await pooledCredentialDir();
  try {
    const plan = buildContainerLaunchPlan(launchInputs(dir));

    // The pool rides the credential sub-directory mount that already existed,
    // read-only, and nothing else in the plan mentions a token.
    const claudeMounts = plan.mounts.filter((mount) =>
      mount.source.endsWith(`/claude`)
    );
    assertEquals(claudeMounts.length, 1);
    assertEquals(claudeMounts[0]?.readOnly, true);
    assertEquals(
      leaks(
        Object.fromEntries(plan.runArgs.map((arg, i) => [String(i), arg])),
        [TOKEN_ONE, TOKEN_TWO, TOKEN_THREE, "provider-2", "provider-3"],
      ),
      [],
    );
    // The named volumes are unaffected by the pool.
    assert(
      plan.mounts.some((mount) =>
        mount.volume && mount.source === APPROVAL_STATE_VOLUME_NAME
      ),
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("the residual filesystem-read risk of a token pool is recorded, not left implicit (Issue #920)", async () => {
  // The environment guarantee above stops at the environment. The container
  // still mounts every token file the pool holds, so a process with read
  // access inside it can read the unselected ones. That is accepted — the
  // agent is assumed compromised and the controls that must hold are
  // containment and egress — but an accepted risk that is not written down is
  // indistinguishable from one nobody noticed. These assertions keep it
  // written down.
  const root = new URL("../../../", import.meta.url);
  const threatModel = await Deno.readTextFile(
    new URL("docs/THREAT-MODEL.md", root),
  );
  const residual = threatModel.slice(
    threatModel.indexOf("## ⚖️ Residual risks"),
  );
  assert(
    /\|\s*\*\*R9\*\*\s*\|/.test(residual),
    "the threat model must carry the residual risk as R9",
  );
  const r9 = residual.split("\n").find((line) => line.includes("**R9**")) ?? "";
  for (const phrase of ["read", "container", "credential"]) {
    assert(
      r9.toLowerCase().includes(phrase),
      `R9 must state the ${phrase} exposure, was: ${r9}`,
    );
  }

  const setup = await Deno.readTextFile(new URL("docs/SETUP.md", root));
  const section = setup.slice(setup.indexOf("#### Several Claude tokens"));
  assert(
    section.includes("THREAT-MODEL.md#-residual-risks"),
    "the several-tokens setup section must point at the recorded residual risk",
  );
});
