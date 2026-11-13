/**
 * Releasing an ephemeral cargo target dir the `agent` account built
 * (Issue #5105). The worker (`vibe`) cannot remove it under the sticky root,
 * so the removal drops to `agent`.
 */
import { assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { cargoTargetDirForCheckout } from "../lib/ephemeral_build_cache.ts";
import {
  releaseCheckoutTargetDirs,
  removeTargetDir,
  targetDirAccount,
  targetDirRemovalAsAccount,
  unmeasuredEphemeralRootDeps,
} from "../lib/heavy_build_gate.ts";

const isRoot = (() => {
  try {
    return new TextDecoder().decode(
      new Deno.Command("id", { args: ["-u"], stdin: "null" }).outputSync()
        .stdout,
    ).trim() === "0";
  } catch {
    return false;
  }
})();

async function exists(path: string): Promise<boolean> {
  try {
    await Deno.lstat(path);
    return true;
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return false;
    throw error;
  }
}

async function makeRoot(): Promise<string> {
  const root = await Deno.makeTempDir({ prefix: "vibe-5105-" });
  await Deno.chmod(root, 0o1777);
  return root;
}

/** Make a tree removable again, then remove it. */
async function forceRemove(path: string): Promise<void> {
  try {
    await Deno.chmod(`${path}/debug`, 0o755);
  } catch {
    // Absent or already writable.
  }
  await Deno.remove(path, { recursive: true }).catch(() => {});
}

const plainRemove = (q: string) => Deno.remove(q, { recursive: true });

Deno.test({
  name: "a pass whose build ran as agent leaves no target dir behind",
  ignore: isRoot, // root ignores directory modes, so EACCES cannot be staged
  async fn() {
    const root = await makeRoot();
    try {
      const checkout = "/work/GRQ-core";
      const dir = cargoTargetDirForCheckout(checkout, {
        root,
        account: "agent",
      });
      const workerDir = cargoTargetDirForCheckout(checkout, { root });
      const otherDir = cargoTargetDirForCheckout("/work/other", {
        root,
        account: "agent",
      });
      for (const d of [dir, workerDir, otherDir]) {
        await Deno.mkdir(`${d}/debug/deps`, { recursive: true });
        await Deno.writeTextFile(`${d}/debug/deps/a`, "x");
      }
      await Deno.chmod(`${dir}/debug`, 0o555);
      // Positive control: a plain recursive remove really is refused.
      await assertRejects(
        () => Deno.remove(`${dir}/debug/deps`, { recursive: true }),
        Deno.errors.PermissionDenied,
      );

      const calls: string[][] = [];
      const fakeSudo = async (argv: string[]) => {
        calls.push(argv);
        await Deno.chmod(`${dir}/debug`, 0o755);
        await Deno.remove(dir, { recursive: true });
        return { code: 0, stderr: "" };
      };
      const released = await releaseCheckoutTargetDirs(checkout, {
        listTargetDirs: unmeasuredEphemeralRootDeps.listTargetDirs,
        removeDir: (p) =>
          removeTargetDir(p, {
            remove: plainRemove,
            removeAsAccount: targetDirRemovalAsAccount({ root, run: fakeSudo }),
          }),
        nowMs: () => 0,
      }, root);

      assertEquals(released.errors, []);
      assertEquals(await exists(dir), false);
      assertEquals(await exists(workerDir), false);
      assertEquals(await exists(otherDir), true);
      assertEquals(calls, [
        ["sudo", "-n", "-u", "agent", "--", "rm", "-rf", "--", dir],
      ]);
    } finally {
      await forceRemove(root);
    }
  },
});

// CI has no `agent` account or passwordless sudo to it, so the real-account
// variant only runs where both exist.
const agentAvailable = (() => {
  try {
    return new Deno.Command("sudo", {
      args: ["-n", "-u", "agent", "--", "true"],
      stdout: "null",
      stderr: "null",
      stdin: "null",
    }).outputSync().success;
  } catch {
    return false;
  }
})();

Deno.test({
  name: "the real agent account's target dir is released through sudo",
  ignore: !agentAvailable,
  async fn() {
    const root = await makeRoot();
    try {
      const checkout = "/work/GRQ-real";
      const dir = cargoTargetDirForCheckout(checkout, {
        root,
        account: "agent",
      });
      const made = new Deno.Command("sudo", {
        args: ["-n", "-u", "agent", "--", "mkdir", "-p", `${dir}/debug/deps`],
        stdout: "null",
        stderr: "piped",
        stdin: "null",
      }).outputSync();
      assertEquals(
        made.success,
        true,
        new TextDecoder().decode(made.stderr),
      );
      const released = await releaseCheckoutTargetDirs(checkout, {
        listTargetDirs: unmeasuredEphemeralRootDeps.listTargetDirs,
        removeDir: (p) =>
          removeTargetDir(p, {
            remove: plainRemove,
            removeAsAccount: targetDirRemovalAsAccount({ root }),
          }),
        nowMs: () => 0,
      }, root);
      assertEquals(released.errors, []);
      assertEquals(await exists(dir), false);
    } finally {
      await Deno.remove(root, { recursive: true }).catch(() => {});
    }
  },
});

Deno.test({
  name: "a failed fallback is reported with both causes and keeps the dir",
  ignore: isRoot,
  async fn() {
    const root = await makeRoot();
    try {
      const checkout = "/work/GRQ-fail";
      const dir = cargoTargetDirForCheckout(checkout, {
        root,
        account: "agent",
      });
      await Deno.mkdir(`${dir}/debug/deps`, { recursive: true });
      await Deno.chmod(`${dir}/debug`, 0o555);
      const released = await releaseCheckoutTargetDirs(checkout, {
        listTargetDirs: unmeasuredEphemeralRootDeps.listTargetDirs,
        removeDir: (p) =>
          removeTargetDir(p, {
            remove: plainRemove,
            removeAsAccount: targetDirRemovalAsAccount({
              root,
              run: () =>
                Promise.resolve({
                  code: 1,
                  stderr: "sudo: a password is required\n",
                }),
            }),
          }),
        nowMs: () => 0,
      }, root);
      assertEquals(released.errors.length, 1);
      assertStringIncludes(released.errors[0]!, "Permission denied");
      assertStringIncludes(released.errors[0]!, "sudo: a password is required");
      assertEquals(await exists(dir), true);
    } finally {
      await forceRemove(cargoTargetDirForCheckout("/work/GRQ-fail", {
        root,
        account: "agent",
      }));
      await Deno.remove(root, { recursive: true }).catch(() => {});
    }
  },
});

Deno.test("targetDirRemovalAsAccount refuses anything but a plain agent dir under a real root", async () => {
  const root = await makeRoot();
  const linkParent = await Deno.makeTempDir({ prefix: "vibe-5105-link-" });
  const link = `${linkParent}/root-link`;
  try {
    await Deno.symlink(root, link);
    const calls: string[][] = [];
    const run = (argv: string[]) => {
      calls.push(argv);
      return Promise.resolve({ code: 0, stderr: "" });
    };
    const remove = targetDirRemovalAsAccount({ root, run });
    const good = `${root}/x-deadbeef-agent`;

    await assertRejects(
      () => remove("root", good),
      Error,
      "root is not the agent account",
    );
    await assertRejects(
      () => remove("agent", `${root}/../x-deadbeef-agent`),
      Error,
      "its parent is not exactly",
    );
    await assertRejects(
      () => remove("agent", `${root}/missing/../x-deadbeef-agent`),
      Error,
      "its parent is not exactly",
    );
    await assertRejects(
      () => remove("agent", `${linkParent}/x-deadbeef-agent`),
      Error,
      "its parent is not exactly",
    );
    await assertRejects(
      () => remove("agent", `${root}/..`),
      Error,
      "not a plain directory name",
    );
    await assertRejects(
      () => remove("agent", `${root}/bad name`),
      Error,
      "not a plain directory name",
    );
    await assertRejects(
      () =>
        targetDirRemovalAsAccount({ root: link, run })(
          "agent",
          `${link}/x-deadbeef-agent`,
        ),
      Error,
      "is not a real directory",
    );
    assertEquals(calls, []);

    await remove("agent", good);
    assertEquals(calls, [
      ["sudo", "-n", "-u", "agent", "--", "rm", "-rf", "--", good],
    ]);
  } finally {
    await Deno.remove(linkParent, { recursive: true }).catch(() => {});
    await Deno.remove(root, { recursive: true }).catch(() => {});
  }
});

Deno.test("targetDirAccount names only an agent-keyed directory", () => {
  const agentDir = cargoTargetDirForCheckout("/work/GRQ-core", {
    root: "/r",
    account: "agent",
  });
  assertEquals(targetDirAccount(agentDir), "agent");
  assertEquals(
    targetDirAccount(
      cargoTargetDirForCheckout("/work/GRQ-core", { root: "/r" }),
    ),
    undefined,
  );
  assertEquals(targetDirAccount("/r/agent"), undefined);
  assertEquals(targetDirAccount("/r/deadbeef-agent"), "agent");
  assertEquals(
    targetDirAccount(`/r/${"a".repeat(100_000)}-agentx`),
    undefined,
  );
  assertEquals(targetDirAccount(`/r/${"a".repeat(100_000)}-agent`), undefined);
});

Deno.test("removeTargetDir only falls back for a refused agent directory", async () => {
  let fallbacks = 0;
  const deps = (error: Error) => ({
    remove: () => Promise.reject(error),
    removeAsAccount: () => {
      fallbacks++;
      return Promise.resolve();
    },
  });
  const agentDir = "/r/x-deadbeef-agent";

  await assertRejects(
    () => removeTargetDir(agentDir, deps(new Deno.errors.NotFound("gone"))),
    Deno.errors.NotFound,
    "gone",
  );
  await assertRejects(
    () =>
      removeTargetDir(
        "/r/x-deadbeef",
        deps(new Deno.errors.PermissionDenied("denied")),
      ),
    Deno.errors.PermissionDenied,
    "denied",
  );
  assertEquals(fallbacks, 0);

  await removeTargetDir(agentDir, deps(new Deno.errors.PermissionDenied("d")));
  assertEquals(fallbacks, 1);
});
