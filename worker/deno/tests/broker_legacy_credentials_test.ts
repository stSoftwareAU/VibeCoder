/** Known legacy credentials block reuse; the inspection never reads or deletes them. */
import { assertEquals, assertRejects } from "@std/assert";
import { inspectBrokerLegacyCredentials } from "../lib/broker_legacy_credentials.ts";

Deno.test("legacy broker guard finds retained gh, Codex and Claude auth without deleting state", async () => {
  const root = await Deno.realPath(await Deno.makeTempDir());
  const workDir = `${root}/work`;
  const agentStateDir = `${root}/agents`;
  const paths = [
    `${workDir}/.container-state/gh/hosts.yml`,
    `${agentStateDir}/codex/auth.json`,
    `${agentStateDir}/claude-config/.credentials.json`,
  ];
  try {
    for (const path of paths) {
      await Deno.mkdir(path.slice(0, path.lastIndexOf("/")), {
        recursive: true,
      });
      await Deno.writeTextFile(path, "synthetic-private-content");
    }
    await Deno.writeTextFile(
      `${agentStateDir}/session.jsonl`,
      "preserve transcript",
    );
    const findings = await inspectBrokerLegacyCredentials({
      workDir,
      agentStateDir,
    });
    assertEquals(
      findings,
      paths.map((path) => ({ path, category: "credential-file" })),
    );
    assertEquals(
      JSON.stringify(findings).includes("synthetic-private-content"),
      false,
    );
    for (const path of paths) {
      assertEquals(await Deno.readTextFile(path), "synthetic-private-content");
    }
    assertEquals(
      await Deno.readTextFile(`${agentStateDir}/session.jsonl`),
      "preserve transcript",
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("legacy broker guard preserves clean worktrees and treats absent state as clean", async () => {
  const root = await Deno.realPath(await Deno.makeTempDir());
  try {
    await Deno.mkdir(`${root}/work/repository`, { recursive: true });
    await Deno.writeTextFile(
      `${root}/work/repository/source.ts`,
      "work in progress",
    );
    assertEquals(
      await inspectBrokerLegacyCredentials({
        workDir: `${root}/work`,
        agentStateDir: `${root}/absent`,
      }),
      [],
    );
    assertEquals(
      await Deno.readTextFile(`${root}/work/repository/source.ts`),
      "work in progress",
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("legacy broker guard refuses symlinked credential ancestors without following them", async () => {
  const visited: string[] = [];
  const findings = await inspectBrokerLegacyCredentials({
    workDir: "/work",
    agentStateDir: "/agents",
    lstat(path) {
      visited.push(path);
      if (path === "/work" || path === "/agents") {
        return Promise.resolve({ isDirectory: true, isSymlink: false });
      }
      if (path === "/agents/codex") {
        return Promise.resolve({ isDirectory: false, isSymlink: true });
      }
      return Promise.reject(new Deno.errors.NotFound());
    },
  });
  assertEquals(findings, [{ path: "/agents/codex", category: "symlink" }]);
  assertEquals(visited.includes("/agents/codex/auth.json"), false);
});

Deno.test("legacy broker guard fails closed on unreadable paths without leaking errors", async () => {
  const findings = await inspectBrokerLegacyCredentials({
    workDir: "/work",
    agentStateDir: "/agents",
    lstat: () =>
      Promise.reject(new Deno.errors.PermissionDenied("secret-file-contents")),
  });
  assertEquals(findings, [{ path: "/work", category: "unreadable" }, {
    path: "/agents",
    category: "unreadable",
  }]);
  assertEquals(
    JSON.stringify(findings).includes("secret-file-contents"),
    false,
  );
});

Deno.test("legacy broker guard includes custom credential locations and deduplicates findings", async () => {
  const root = await Deno.realPath(await Deno.makeTempDir());
  try {
    const path = `${root}/custom/auth.json`;
    await Deno.mkdir(`${root}/custom`);
    await Deno.writeTextFile(path, "secret");
    assertEquals(
      await inspectBrokerLegacyCredentials({
        workDir: `${root}/absent`,
        agentStateDir: `${root}/missing`,
        extraCredentialPaths: [path, path],
      }),
      [{ path, category: "credential-file" }],
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("legacy broker guard refuses ambiguous roots before filesystem access", async () => {
  let calls = 0;
  for (
    const workDir of [
      "",
      "/",
      "relative",
      "/work/../private",
      "/work\\private",
      "/work\0bad",
    ]
  ) {
    await assertRejects(() =>
      inspectBrokerLegacyCredentials({
        workDir,
        agentStateDir: "/agents",
        lstat() {
          calls++;
          return Promise.reject(new Deno.errors.NotFound());
        },
      })
    );
  }
  assertEquals(calls, 0);
});
