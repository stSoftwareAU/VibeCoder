/**
 * The coding agent's own state lives on its own volume (Issue #1407).
 *
 * The agent's configuration, session stores and memories used to sit inside
 * the work directory beside every repository clone. That coupling is what
 * made bounding the work volume expensive — any grant tightened there risked
 * locking the agent out of its own state.
 *
 * Two properties are asserted here, and they pull in opposite directions on
 * purpose: the store is a **sibling** of the work directory (so tightening the
 * work volume cannot reach it), and the agent keeps **unrestricted** access to
 * it (so containment never stops the agent doing its job).
 *
 * Uses Australian English throughout (behaviour, colour, organisation).
 */

import { assert, assertEquals } from "@std/assert";
import { resolveAgentStateDir } from "../lib/agent_state_dir.ts";
import { resolveContentApprovalStateDir } from "../lib/content_approval_state_dir.ts";
import {
  getSessionStorePath,
  getWorkStreamSessionPath,
} from "../lib/session_manager.ts";
import { buildClaudeChildEnv } from "../lib/claude_env.ts";

const WORK = "/home/vibe/auto-issue-work";

Deno.test("agent state - the store is a sibling of the work dir, never a child", () => {
  const dir = resolveAgentStateDir(WORK);
  assertEquals(dir, `${WORK}-agent-state`);
  // The load-bearing property: nothing under the work tree, so a grant
  // tightened on the work volume cannot reach the agent's own state, and a
  // sweep that empties the work dir cannot take the sessions with it.
  assert(!dir.startsWith(`${WORK}/`), "must not be inside the work directory");
});

Deno.test("agent state - it does not collide with the approval-state sibling", () => {
  // Both are siblings of the work dir on their own volumes; they must not
  // resolve to the same directory or one would mount over the other.
  assert(resolveAgentStateDir(WORK) !== resolveContentApprovalStateDir(WORK));
});

Deno.test("agent state - a trailing slash does not produce a doubled separator", () => {
  assertEquals(resolveAgentStateDir(`${WORK}/`), `${WORK}-agent-state`);
});

Deno.test("agent state - an unconfigured work dir yields the empty sentinel", () => {
  // Matches resolveContentApprovalStateDir: callers fall back rather than
  // inventing a relative directory.
  assertEquals(resolveAgentStateDir(""), "");
  assertEquals(resolveAgentStateDir("   "), "");
  assertEquals(resolveAgentStateDir("/"), "");
});

Deno.test("agent state - the session store is rooted on the agent-state volume", () => {
  assertEquals(
    getSessionStorePath(WORK, "owner/repo"),
    `${WORK}-agent-state/.claude-sessions/owner/repo`,
  );
});

Deno.test("agent state - session isolation per repo and work stream is unchanged", () => {
  // The reason isolation was never the problem: the store was already keyed
  // per owner, per repo and per work stream. Only the root moved.
  const a = getWorkStreamSessionPath(WORK, "owner/repo-a");
  const b = getWorkStreamSessionPath(WORK, "owner/repo-b");
  const milestone = getWorkStreamSessionPath(WORK, "owner/repo-a", 42);
  assert(a !== b, "different repositories keep different stores");
  assert(a !== milestone, "different work streams keep different stores");
  assert(a.startsWith(`${WORK}-agent-state/`));
});

Deno.test("agent state - a blank work dir falls back to the previous rooting", () => {
  // The sentinel must not produce a bogus relative path like
  // "-agent-state/.claude-sessions/…".
  assertEquals(
    getSessionStorePath("", "owner/repo"),
    "/.claude-sessions/owner/repo",
  );
});

Deno.test("agent state - the agent's config dir is on the same volume", () => {
  const env = buildClaudeChildEnv({
    HOME: "/home/vibe",
    PATH: "/usr/local/bin",
    WORK_DIR: WORK,
    VIBE_IMAGE_AGENT_PROVIDERS: "claude",
  });
  assertEquals(
    env["CLAUDE_CONFIG_DIR"],
    `${resolveAgentStateDir(WORK)}/claude-config`,
  );
});

Deno.test("agent state - an operator's explicit CLAUDE_CONFIG_DIR still wins", () => {
  const env = buildClaudeChildEnv({
    HOME: "/home/vibe",
    WORK_DIR: WORK,
    VIBE_IMAGE_AGENT_PROVIDERS: "claude",
    CLAUDE_CONFIG_DIR: "/custom/claude",
  });
  assertEquals(env["CLAUDE_CONFIG_DIR"], "/custom/claude");
});
