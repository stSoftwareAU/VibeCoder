/**
 * Tests for the custom-prompt mount derivation (Issue #850, part of #843).
 *
 * The mount plan is a containment decision: it turns the operator's configured
 * host prompt paths into the narrowest read-only mount set that makes them
 * readable inside the container, plus the host → in-container translation the
 * worker applies when it loads the same `.config.json` on the other side of
 * the boundary. These tests call the real functions with real paths and assert
 * on what they return.
 *
 * Australian English spelling throughout (behaviour, organisation).
 */

import { assertEquals, assertStringIncludes, assertThrows } from "@std/assert";
import {
  assertCustomPromptSourceResolvable,
  CUSTOM_PROMPT_PATH_MAP_ENV,
  customPromptPathResolver,
  parseCustomPromptPathMap,
  planCustomPromptMounts,
} from "../lib/custom_prompt_mounts.ts";

const TARGET_BASE = "/home/vibe/.vibe-coder/custom-prompts";

Deno.test("planCustomPromptMounts - no configured prompts means no mounts", () => {
  const plan = planCustomPromptMounts([], TARGET_BASE);
  assertEquals(plan.mounts, []);
  assertEquals(plan.translations, {});
});

Deno.test("planCustomPromptMounts - mounts the containing directory, not the file", () => {
  const plan = planCustomPromptMounts(
    ["/srv/vibe-prompts/private-label.md"],
    TARGET_BASE,
  );
  assertEquals(plan.mounts, [
    { source: "/srv/vibe-prompts", target: `${TARGET_BASE}/1` },
  ]);
  assertEquals(plan.translations, {
    "/srv/vibe-prompts/private-label.md": `${TARGET_BASE}/1/private-label.md`,
  });
});

Deno.test("planCustomPromptMounts - prompts sharing a directory share one mount", () => {
  const plan = planCustomPromptMounts(
    [
      "/srv/vibe-prompts/one.md",
      "/srv/vibe-prompts/two.md",
      // A doubled-separator spelling of the same directory is the same mount.
      "/srv/vibe-prompts//three.md",
    ],
    TARGET_BASE,
  );
  assertEquals(plan.mounts, [
    { source: "/srv/vibe-prompts", target: `${TARGET_BASE}/1` },
  ]);
  assertEquals(Object.keys(plan.translations).length, 3);
  assertEquals(
    plan.translations["/srv/vibe-prompts/two.md"],
    `${TARGET_BASE}/1/two.md`,
  );
  // Keyed by the path exactly as configured, so the worker can look up what
  // it read from `.config.json`.
  assertEquals(
    plan.translations["/srv/vibe-prompts//three.md"],
    `${TARGET_BASE}/1/three.md`,
  );
});

Deno.test("assertCustomPromptSourceResolvable - a traversal segment is refused (Issue #850)", () => {
  // The mount-source allowlist compares strings: `/srv/../home/operator` is
  // not string-equal to the home directory but is exactly it once the runtime
  // resolves the mount, so the spelling is refused before it gets there.
  const error = assertThrows(
    () =>
      assertCustomPromptSourceResolvable(
        "/srv/../home/operator/private.md",
        (path) => path,
      ),
    Error,
  );
  assertStringIncludes(error.message, "..");
  assertStringIncludes(error.message, "Refusing to launch");

  assertThrows(
    () =>
      assertCustomPromptSourceResolvable("/srv/./prompts/a.md", (path) => path),
    Error,
  );
});

Deno.test("assertCustomPromptSourceResolvable - a symlinked path is refused, naming where it resolves (Issue #850)", () => {
  const error = assertThrows(
    () =>
      assertCustomPromptSourceResolvable(
        "/srv/prompts/a.md",
        () => "/home/operator/a.md",
      ),
    Error,
  );
  assertStringIncludes(error.message, "/home/operator/a.md");

  // An unresolvable path fails loudly too — never silently mounted.
  const missing = assertThrows(
    () =>
      assertCustomPromptSourceResolvable("/srv/prompts/a.md", () => {
        throw new Deno.errors.NotFound("no such file");
      }),
    Error,
  );
  assertStringIncludes(missing.message, "cannot be resolved");
});

Deno.test("assertCustomPromptSourceResolvable - a canonical path is accepted", () => {
  assertCustomPromptSourceResolvable("/srv/prompts/a.md", (path) => path);
});

Deno.test("planCustomPromptMounts - distinct directories are numbered in configuration order", () => {
  const plan = planCustomPromptMounts(
    [
      "/srv/first/alpha.md",
      "/opt/second/beta.md",
      "/srv/first/gamma.md",
    ],
    TARGET_BASE,
  );
  assertEquals(plan.mounts, [
    { source: "/srv/first", target: `${TARGET_BASE}/1` },
    { source: "/opt/second", target: `${TARGET_BASE}/2` },
  ]);
  assertEquals(plan.translations, {
    "/srv/first/alpha.md": `${TARGET_BASE}/1/alpha.md`,
    "/opt/second/beta.md": `${TARGET_BASE}/2/beta.md`,
    "/srv/first/gamma.md": `${TARGET_BASE}/1/gamma.md`,
  });
});

Deno.test("planCustomPromptMounts - a prompt at the filesystem root keeps the root as its source", () => {
  // Not repaired here: the mount source is handed to the launch plan's own
  // allowlist, which refuses the filesystem root loudly (Issue #4060).
  const plan = planCustomPromptMounts(["/rogue.md"], TARGET_BASE);
  assertEquals(plan.mounts, [{ source: "/", target: `${TARGET_BASE}/1` }]);
});

Deno.test("planCustomPromptMounts - Windows hosts split on either separator", () => {
  const plan = planCustomPromptMounts(
    ["C:\\vibe\\prompts\\private.md"],
    TARGET_BASE,
    "windows",
  );
  assertEquals(plan.mounts, [
    { source: "C:\\vibe\\prompts", target: `${TARGET_BASE}/1` },
  ]);
  // The in-container side is POSIX on every host.
  assertEquals(plan.translations, {
    "C:\\vibe\\prompts\\private.md": `${TARGET_BASE}/1/private.md`,
  });
});

Deno.test("parseCustomPromptPathMap - an unset or empty variable means no translation", () => {
  assertEquals(parseCustomPromptPathMap(undefined), {});
  assertEquals(parseCustomPromptPathMap(""), {});
  assertEquals(parseCustomPromptPathMap("   "), {});
});

Deno.test("parseCustomPromptPathMap - a valid map round-trips", () => {
  const plan = planCustomPromptMounts(["/srv/p/a.md"], TARGET_BASE);
  assertEquals(
    parseCustomPromptPathMap(JSON.stringify(plan.translations)),
    plan.translations,
  );
});

Deno.test("parseCustomPromptPathMap - malformed values fail loud", () => {
  const malformed = assertThrows(
    () => parseCustomPromptPathMap("{not json"),
    Error,
  );
  assertStringIncludes(malformed.message, CUSTOM_PROMPT_PATH_MAP_ENV);

  const notObject = assertThrows(
    () => parseCustomPromptPathMap('["/srv/p/a.md"]'),
    Error,
  );
  assertStringIncludes(notObject.message, CUSTOM_PROMPT_PATH_MAP_ENV);

  const notStrings = assertThrows(
    () => parseCustomPromptPathMap('{"/srv/p/a.md": 7}'),
    Error,
  );
  assertStringIncludes(notStrings.message, "/srv/p/a.md");
});

Deno.test("customPromptPathResolver - a host-side read leaves the path unchanged", () => {
  const resolve = customPromptPathResolver(undefined);
  assertEquals(resolve("/srv/vibe-prompts/a.md"), "/srv/vibe-prompts/a.md");
});

Deno.test("customPromptPathResolver - inside the container it resolves onto the mount", () => {
  const plan = planCustomPromptMounts(
    ["/srv/vibe-prompts/a.md"],
    TARGET_BASE,
  );
  const resolve = customPromptPathResolver(JSON.stringify(plan.translations));
  assertEquals(
    resolve("/srv/vibe-prompts/a.md"),
    `${TARGET_BASE}/1/a.md`,
  );
  // A path the map does not name is passed through untouched, so the config
  // loader's own readability check fails loud naming the configured path
  // rather than a silently invented one.
  assertEquals(resolve("/srv/other/b.md"), "/srv/other/b.md");
});
