/**
 * Tests for side_repo_clone_args.ts — blobless clones for tier-2 side/data
 * repositories (Issue #243).
 *
 * Covers the fleet default, an operator override winning verbatim, the
 * documented empty-value opt-out, refusal of an override that is not a plain
 * `git clone` option, the argv split used by the worker's own clones, and the
 * fact that the variable survives the agent child-environment filter — the
 * gate/agent runs are what have to receive it.
 *
 * Australian English spelling throughout (behaviour, organisation).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  DEFAULT_SIDE_REPO_CLONE_ARGS,
  resolveSideRepoCloneArgs,
  SIDE_REPO_CLONE_ARGS_ENV,
  sideRepoCloneArgList,
} from "../lib/side_repo_clone_args.ts";
import { buildAgentChildEnv } from "../lib/agent_env.ts";

/** Environment reader over a fixed map. */
function envFrom(map: Record<string, string>) {
  return (name: string): string | undefined => map[name];
}

Deno.test("resolveSideRepoCloneArgs - unset yields the blobless default", () => {
  const resolved = resolveSideRepoCloneArgs(envFrom({}));
  assertEquals(resolved.value, "--filter=blob:none");
  assertEquals(resolved.value, DEFAULT_SIDE_REPO_CLONE_ARGS);
  assertEquals(resolved.source, "default");
  assertEquals(resolved.reason, undefined);
});

Deno.test("resolveSideRepoCloneArgs - operator override wins verbatim", () => {
  const resolved = resolveSideRepoCloneArgs(
    envFrom({
      [SIDE_REPO_CLONE_ARGS_ENV]: "--filter=blob:limit=1m --no-tags",
    }),
  );
  assertEquals(resolved.value, "--filter=blob:limit=1m --no-tags");
  assertEquals(resolved.source, "override");
});

Deno.test("resolveSideRepoCloneArgs - empty override opts out of the filter", () => {
  const resolved = resolveSideRepoCloneArgs(
    envFrom({ [SIDE_REPO_CLONE_ARGS_ENV]: "" }),
  );
  assertEquals(resolved.value, "");
  assertEquals(resolved.source, "override");
  assertEquals(
    sideRepoCloneArgList(envFrom({ [SIDE_REPO_CLONE_ARGS_ENV]: "" })),
    [],
  );
});

Deno.test("resolveSideRepoCloneArgs - shell metacharacters are refused loudly", () => {
  const resolved = resolveSideRepoCloneArgs(
    envFrom({
      [SIDE_REPO_CLONE_ARGS_ENV]: "--filter=blob:none; rm -rf /",
    }),
  );
  // The default stands and the refusal is reported — never silently mangled.
  assertEquals(resolved.value, DEFAULT_SIDE_REPO_CLONE_ARGS);
  assertEquals(resolved.source, "rejected");
  assertStringIncludes(resolved.reason ?? "", SIDE_REPO_CLONE_ARGS_ENV);
});

Deno.test("resolveSideRepoCloneArgs - a bare word is not a clone option", () => {
  const resolved = resolveSideRepoCloneArgs(
    envFrom({ [SIDE_REPO_CLONE_ARGS_ENV]: "origin" }),
  );
  assertEquals(resolved.source, "rejected");
  assertEquals(resolved.value, DEFAULT_SIDE_REPO_CLONE_ARGS);
});

Deno.test("sideRepoCloneArgList - splits the resolved value into argv tokens", () => {
  assertEquals(sideRepoCloneArgList(envFrom({})), ["--filter=blob:none"]);
  assertEquals(
    sideRepoCloneArgList(
      envFrom({ [SIDE_REPO_CLONE_ARGS_ENV]: "  --filter=tree:0   --no-tags " }),
    ),
    ["--filter=tree:0", "--no-tags"],
  );
});

Deno.test("agent child env - the clone arguments reach the agent", () => {
  const child = buildAgentChildEnv({
    [SIDE_REPO_CLONE_ARGS_ENV]: DEFAULT_SIDE_REPO_CLONE_ARGS,
    GITHUB_APP_PRIVATE_KEY: "secret",
  }, { denylist: ["GITHUB_APP_PRIVATE_KEY"], secretAllowlist: [] });

  assertEquals(child[SIDE_REPO_CLONE_ARGS_ENV], DEFAULT_SIDE_REPO_CLONE_ARGS);
  assert(!("GITHUB_APP_PRIVATE_KEY" in child));
});
