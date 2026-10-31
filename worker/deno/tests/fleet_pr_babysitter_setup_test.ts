import { assert, assertEquals } from "@std/assert";
import {
  launchAgentPlist,
  missingAppPermissions,
} from "../commands/fleet_pr_babysitter_setup.ts";
import { runWithTimeout } from "../lib/subprocess_timeout.ts";

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

Deno.test("folder scripts forward options to the right Deno command", async () => {
  const dir = await Deno.makeTempDir({ prefix: "babysitter-setup-test-" });
  try {
    const fake = `${dir}/fake-deno`;
    await Deno.writeTextFile(fake, '#!/bin/sh\nprintf "%s\\n" "$@"\n', {
      mode: 0o755,
    });
    const checkout = decodeURIComponent(
      new URL("../../..", import.meta.url).pathname,
    ).replace(/\/$/, "");
    for (
      const [script, target, option] of [
        ["setup.sh", "fleet_pr_babysitter_setup.ts", "--check"],
        ["run.sh", "fleet_pr_babysitter.ts", "--dry-run"],
      ] as const
    ) {
      const result = await runWithTimeout("bash", [
        `${checkout}/fleet-pr-babysitter/${script}`,
        option,
      ], { cwd: dir, timeoutMs: 5_000, env: { DENO_EXECUTABLE: fake } });
      assert(result.ok);
      assert(result.value.success);
      assert(result.value.stdout.includes(target));
      assert(result.value.stdout.includes(option));
    }
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
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
      "/tmp/A &amp; B/fleet-pr-babysitter/run.sh",
    ),
  );
  assert(plist.includes("<string>--watch</string>"));
  assert(
    plist.includes("<key>DENO_EXECUTABLE</key><string>/usr/bin/deno</string>"),
  );
  assert(plist.includes("/tmp/gh &lt;fleet&gt;"));
  assert(!plist.includes("GH_TOKEN"));
});
