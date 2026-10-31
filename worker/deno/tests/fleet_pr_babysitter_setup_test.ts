import { assert, assertEquals } from "@std/assert";
import {
  launchAgentPlist,
  missingAppPermissions,
} from "../commands/fleet_pr_babysitter_setup.ts";

Deno.test("setup validates each App permission including write levels", () => {
  const permissions = {
    actions: "read",
    checks: "read",
    contents: "write",
    issues: "write",
    pull_requests: "write",
    statuses: "read",
    workflows: "write",
  };
  assertEquals(missingAppPermissions(permissions), []);
  assertEquals(
    missingAppPermissions({ ...permissions, issues: "read", actions: "write" }),
    ["issues: write"],
  );
  assert(missingAppPermissions(undefined).includes("contents: write"));
});

Deno.test("launch agent runs the watcher and escapes filesystem paths", () => {
  const plist = launchAgentPlist({
    checkout: "/tmp/A & B",
    deno: "/usr/bin/deno",
    home: "/Users/Owner",
    ghConfigDir: "/tmp/gh <fleet>",
  });
  assert(
    plist.includes(
      "/tmp/A &amp; B/worker/deno/commands/fleet_pr_babysitter.ts",
    ),
  );
  assert(plist.includes("<string>--watch</string>"));
  assert(plist.includes("/tmp/gh &lt;fleet&gt;"));
  assert(!plist.includes("GH_TOKEN"));
});
