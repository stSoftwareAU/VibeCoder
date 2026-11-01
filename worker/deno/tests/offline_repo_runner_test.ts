import { assertEquals, assertStringIncludes, assertThrows } from "@std/assert";
import {
  checkOfflineSnapshotEntries,
  runOfflineRepoCheck,
} from "../lib/offline_repo_runner.ts";

Deno.test("offline runner refuses unpinned or unsupported requests before launching", async () => {
  const request = {
    sourceRepo: "/unused",
    head: "main",
    cwd: ".",
    argv: ["bash", "test.sh"],
    hostRoot: "/unused",
  };
  assertEquals((await runOfflineRepoCheck(request)).status, "unavailable");
  assertEquals(
    (await runOfflineRepoCheck({
      ...request,
      head: "a".repeat(40),
      argv: ["/bin/sh"],
    })).status,
    "unavailable",
  );
  assertEquals(
    (await runOfflineRepoCheck({
      ...request,
      head: "a".repeat(40),
      cwd: "../outside",
    })).status,
    "unavailable",
  );
});

Deno.test("snapshot limits reject excessive trees and unsupported entries", () => {
  checkOfflineSnapshotEntries("100644 134217728");
  assertThrows(() => checkOfflineSnapshotEntries("100644 134217729"));
  assertThrows(() =>
    checkOfflineSnapshotEntries(Array(20_001).fill("100644 0").join("\n"))
  );
  assertThrows(() => checkOfflineSnapshotEntries("160000 0"));
  assertThrows(() => checkOfflineSnapshotEntries("100644 9007199254740992"));
});

Deno.test({
  name:
    "Apple offline runner executes only the pinned snapshot with no inherited credentials",
  ignore: !Deno.env.get("VIBE_OFFLINE_TEST_IMAGE"),
  async fn() {
    const root = await Deno.makeTempDir();
    const git = async (...args: string[]) => {
      const result = await new Deno.Command("git", { args, cwd: root })
        .output();
      if (!result.success) {
        throw new Error(new TextDecoder().decode(result.stderr));
      }
      return new TextDecoder().decode(result.stdout).trim();
    };
    try {
      await git("init");
      await git("config", "user.name", "Test");
      await git("config", "user.email", "test@example.invalid");
      await Deno.writeTextFile(
        `${root}/check.sh`,
        '#!/bin/sh\nset -eu\ntest -z "${GH_TOKEN:-}"\ntest -z "${GITHUB_TOKEN:-}"\ntest ! -e /fixture/repo/.git\ntest ! -e /fixture/secret\nif printf x >> /fixture/readonly-probe 2>/dev/null; then exit 41; fi\nif (echo > /dev/tcp/1.1.1.1/443) 2>/dev/null; then exit 42; fi\nprintf good > writable-check\nprintf \'pinned passed\\n\'\n',
      );
      await Deno.writeTextFile(
        `${root}/fail.sh`,
        "#!/bin/sh\necho expected-failure >&2\nexit 7\n",
      );
      await Deno.symlink("/etc", `${root}/escape`);
      await git("add", "check.sh", "fail.sh", "escape");
      await git("commit", "-m", "fixture");
      const head = await git("rev-parse", "HEAD");
      await Deno.writeTextFile(`${root}/check.sh`, "exit 9\n");
      const request = {
        sourceRepo: root,
        head,
        cwd: ".",
        argv: ["bash", "check.sh"],
        hostRoot: root,
        image: Deno.env.get("VIBE_OFFLINE_TEST_IMAGE")!,
      };
      const passed = await runOfflineRepoCheck(request);
      assertEquals(passed.status, "passed");
      if (passed.status === "passed") {
        assertStringIncludes(passed.output, "pinned passed");
      }
      const escaped = await runOfflineRepoCheck({
        ...request,
        cwd: "escape",
      });
      assertEquals(escaped.status, "unavailable");
      const failed = await runOfflineRepoCheck({
        ...request,
        argv: ["bash", "fail.sh"],
      });
      assertEquals(failed.status, "failed");
      if (failed.status === "failed") assertEquals(failed.code, 7);
    } finally {
      await Deno.remove(root, { recursive: true });
    }
  },
});
