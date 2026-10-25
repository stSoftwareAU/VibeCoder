/**
 * Nothing the coding agent starts may write the worker's audit journal
 * (Issue #2400).
 *
 * Live incident (2026-09-19): while an implementation run's agent ran
 * `deno test --allow-all tests/` inside the worker container, a test process
 * took the production journal's append lock and died holding it. A real
 * GitHub mutation went unrecorded (`[AUDIT_JOURNAL_REFUSED]`) and the lock
 * stood for 520 s before the abandoned-lock breaker cleared it.
 *
 * The journal switches on wherever `WORK_DIR` is set, and the agent's child
 * environment is the worker's minus a denylist — so every `deno test` the
 * agent starts inherited the switch, the worker id and the run id, and ~85
 * test files that drive real `git` against fixture repositories appended
 * their fixture pushes to the tamper-evident trail as if the worker had made
 * them.
 *
 * The journal belongs to the worker process. These tests pin that for every
 * provider, and pin the other direction: the worker's own journal stays on.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assertEquals } from "@std/assert";
import {
  buildAgentChildEnv,
  WORKER_ONLY_SECRET_ENV_VARS,
} from "../lib/agent_env.ts";
import { isAuditJournalEnabled } from "../lib/audit_hook.ts";
import { resolveBaseDir } from "../lib/audit_journal.ts";
import { buildClaudeChildEnv } from "../lib/claude_env.ts";
import { buildCodexChildEnv } from "../lib/codex_env.ts";
import { buildDeepSeekChildEnv } from "../lib/deepseek_env.ts";
import { buildGeminiChildEnv } from "../lib/gemini_env.ts";
import { EGRESS_PROXY_ENV_NAMES } from "../lib/container_egress.ts";

/** The worker container's environment, as far as the journal reads it. */
const WORKER_ENV: Record<string, string> = {
  WORK_DIR: "/home/vibe/auto-issue-work",
  WORKER_UNIQUE_ID: "host-a",
  VIBE_RUN_ID: "vibe-test-run",
  PATH: "/usr/bin",
  HOME: "/home/vibe",
};

const lookup = (env: Record<string, string>) => (name: string) => env[name];

/** The four providers' child-environment builders, each on its real default. */
const PROVIDER_CHILD_ENV: Record<
  string,
  (env: Record<string, string>) => Record<string, string>
> = {
  claude: (env) => buildClaudeChildEnv(env),
  codex: (env) => buildCodexChildEnv(env),
  deepseek: (env) => buildDeepSeekChildEnv(env),
  gemini: (env) => buildGeminiChildEnv(env),
};

/** The egress proxy variables, each valued by its own name so a swap shows. */
const PROXY_ENV: Record<string, string> = Object.fromEntries(
  EGRESS_PROXY_ENV_NAMES.map((name) => [name, `value-of-${name}`]),
);

/** Secrets no provider's child may inherit, whatever its own allowlist says. */
const SECRET_ENV: Record<string, string> = {
  GITHUB_APP_PRIVATE_KEY: "-----BEGIN PRIVATE KEY-----",
  ACME_SERVICE_TOKEN: "acme-live-token",
};

Deno.test("the worker's own journal is on — the fixture is a production-shaped environment", () => {
  assertEquals(isAuditJournalEnabled(lookup(WORKER_ENV)), true);
  assertEquals(
    resolveBaseDir(undefined, lookup(WORKER_ENV)),
    "/home/vibe/auto-issue-work/audit",
  );
});

Deno.test("buildAgentChildEnv - the child cannot journal, and still has the WORK_DIR it needs for everything else", () => {
  const child = buildAgentChildEnv(WORKER_ENV, {
    denylist: [],
    secretAllowlist: [],
  });
  assertEquals(isAuditJournalEnabled(lookup(child)), false);
  assertEquals(child.WORK_DIR, WORKER_ENV.WORK_DIR);
  assertEquals(child.PATH, WORKER_ENV.PATH);
});

Deno.test("buildAgentChildEnv - a parent that says the journal is on cannot hand that to the child", () => {
  for (const value of ["0", "false", "", "no"]) {
    const child = buildAgentChildEnv(
      { ...WORKER_ENV, VIBE_AUDIT_DISABLED: value },
      { denylist: [], secretAllowlist: [] },
    );
    assertEquals(isAuditJournalEnabled(lookup(child)), false, value);
  }
});

Deno.test("buildAgentChildEnv - does not mutate the worker's environment", () => {
  const parent = { ...WORKER_ENV };
  buildAgentChildEnv(parent, { denylist: [], secretAllowlist: [] });
  assertEquals(parent, WORKER_ENV);
  assertEquals(isAuditJournalEnabled(lookup(parent)), true);
});

Deno.test("every provider's child environment has the journal off", () => {
  for (const [provider, build] of Object.entries(PROVIDER_CHILD_ENV)) {
    const child = build({ ...WORKER_ENV });
    assertEquals(
      isAuditJournalEnabled(lookup(child)),
      false,
      `${provider}: a test the agent runs would journal into production`,
    );
  }
});

Deno.test("buildAgentChildEnv - the egress proxy variables survive the generic policy, and secrets do not", () => {
  const child = buildAgentChildEnv(
    { ...WORKER_ENV, ...PROXY_ENV, ...SECRET_ENV },
    { denylist: [...WORKER_ONLY_SECRET_ENV_VARS], secretAllowlist: [] },
  );
  for (const name of EGRESS_PROXY_ENV_NAMES) {
    assertEquals(child[name], PROXY_ENV[name], `${name} must reach the child`);
  }
  for (const name of Object.keys(SECRET_ENV)) {
    assertEquals(child[name], undefined, `${name} must not reach the child`);
  }
});

Deno.test("every provider's child keeps the egress proxy variables unchanged and still loses its secrets", () => {
  for (const [provider, build] of Object.entries(PROVIDER_CHILD_ENV)) {
    const child = build({ ...WORKER_ENV, ...PROXY_ENV, ...SECRET_ENV });
    for (const name of EGRESS_PROXY_ENV_NAMES) {
      assertEquals(
        child[name],
        PROXY_ENV[name],
        `${provider}: ${name} must reach the child unchanged`,
      );
    }
    for (const name of Object.keys(SECRET_ENV)) {
      assertEquals(
        child[name],
        undefined,
        `${provider}: ${name} must not reach the child`,
      );
    }
  }
});
