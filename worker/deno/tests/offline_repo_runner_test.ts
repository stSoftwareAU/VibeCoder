import { assertEquals, assertStringIncludes, assertThrows } from "@std/assert";
import {
  checkOfflineSnapshotEntries,
  runOfflineRepoCheck,
  runPairedOfflineDenoTest,
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
      await Deno.writeTextFile(`${root}/host-only-secret`, "host secret");
      await Deno.writeTextFile(
        `${root}/check.sh`,
        `#!/bin/sh\nset -eu\ntest -z "\${GH_TOKEN:-}"\ntest -z "\${GITHUB_TOKEN:-}"\ntest ! -e /fixture/repo/.git\ntest ! -e '${root}/host-only-secret'\nif printf x >> /fixture/readonly-probe 2>/dev/null; then exit 41; fi\nif (echo > /dev/tcp/1.1.1.1/443) 2>/dev/null; then exit 42; fi\nprintf good > writable-check\nprintf 'pinned passed\\n'\n`,
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

Deno.test({
  name:
    "Apple paired check binds head test overlay and defers ambiguous base failure",
  ignore: !Deno.env.get("VIBE_OFFLINE_TEST_IMAGE"),
  async fn() {
    const root = await Deno.makeTempDir();
    const git = async (...args: string[]) => {
      const out = await new Deno.Command("git", { args, cwd: root }).output();
      if (!out.success) throw new Error(new TextDecoder().decode(out.stderr));
      return new TextDecoder().decode(out.stdout).trim();
    };
    try {
      await git("init");
      await git("config", "user.name", "Test");
      await git("config", "user.email", "test@example.invalid");
      await Deno.writeTextFile(`${root}/value.ts`, "export const value = 1;\n");
      await git("add", "value.ts");
      await git("commit", "-m", "base");
      const base = await git("rev-parse", "HEAD");
      await Deno.writeTextFile(`${root}/value.ts`, "export const value = 2;\n");
      await Deno.writeTextFile(
        `${root}/value_test.ts`,
        `import { value } from "./value.ts";
Deno.test("value", () => { if (value !== 2) throw Error("wrong value"); });
`,
      );
      await git("add", "value.ts", "value_test.ts");
      await git("commit", "-m", "head");
      const head = await git("rev-parse", "HEAD");
      const result = await runPairedOfflineDenoTest({
        sourceRepo: root,
        base,
        head,
        cwd: ".",
        testPath: "value_test.ts",
        hostRoot: root,
        image: Deno.env.get("VIBE_OFFLINE_TEST_IMAGE")!,
      });
      assertEquals(result.status, "unavailable");
      if (result.status === "unavailable") {
        assertEquals(result.head?.status, "passed");
        assertEquals(result.base?.status, "failed");
      }
      const same = await runPairedOfflineDenoTest({
        sourceRepo: root,
        base: head,
        head,
        cwd: ".",
        testPath: "value_test.ts",
        hostRoot: root,
        image: Deno.env.get("VIBE_OFFLINE_TEST_IMAGE")!,
      });
      assertEquals(same.status, "observed");
      if (same.status === "observed") {
        assertEquals(same.base.status, "passed");
        assertEquals(same.head.status, "passed");
        assertEquals(same.blob.length, 40);
      }
      const invalid = await runPairedOfflineDenoTest({
        sourceRepo: root,
        base,
        head,
        cwd: ".",
        testPath: "../value_test.ts",
        hostRoot: root,
      });
      assertEquals(invalid.status, "unavailable");
    } finally {
      await Deno.remove(root, { recursive: true });
    }
  },
});
