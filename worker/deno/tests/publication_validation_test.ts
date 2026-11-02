import { assert, assertEquals } from "@std/assert";
import {
  publicationTreeIdentity,
  publicationValidationIsCurrent,
  validateRepositoryForPublication,
} from "../lib/publication_validation.ts";
import type { runRepositoryCommand } from "../lib/untrusted_gate_spawn.ts";

async function checkout(script: string): Promise<string> {
  const cwd = await Deno.makeTempDir({ prefix: "publication-validation-" });
  const git = async (...args: string[]) => {
    const p = new Deno.Command("git", {
      args,
      cwd,
      stdin: "null",
      stdout: "null",
      stderr: "piped",
    }).output();
    const result = await p;
    if (result.code !== 0) {
      throw new Error(new TextDecoder().decode(result.stderr));
    }
  };
  await git("init", "-q");
  await git("config", "user.email", "test@example.invalid");
  await git("config", "user.name", "Test");
  await Deno.writeTextFile(`${cwd}/quality.sh`, script);
  await Deno.chmod(`${cwd}/quality.sh`, 0o755);
  await git("add", "quality.sh");
  await git("commit", "-qm", "fixture");
  return cwd;
}

function shellRunner(): typeof runRepositoryCommand {
  return (executable, args, options) => {
    assertEquals(args, ["--strict"]);
    const child = new Deno.Command("bash", {
      args: [executable, ...args],
      cwd: options.cwd,
      stdin: "null",
      stdout: "piped",
      stderr: "piped",
    }).output();
    return child.then((value) => ({
      ok: true as const,
      value: {
        success: value.code === 0,
        code: value.code,
        stdout: new TextDecoder().decode(value.stdout),
        stderr: new TextDecoder().decode(value.stderr),
        timedOut: false,
      },
    }));
  };
}

Deno.test("publication validation executes quality.sh and rejects a real failure", async () => {
  const cwd = await checkout(
    "#!/bin/sh\necho check-ran\necho cause >&2\nexit 7\n",
  );
  try {
    const result = await validateRepositoryForPublication(cwd, {
      run: shellRunner(),
    });
    assertEquals(result.status, "failed");
    if (result.status === "failed") assert(result.output.includes("cause"));
  } finally {
    await Deno.remove(cwd, { recursive: true });
  }
});

Deno.test("publication validation rejects a Deno test compilation failure", async () => {
  const cwd = await checkout(
    "#!/bin/sh\nexec deno test --no-config --no-lock broken_test.ts\n",
  );
  try {
    await Deno.writeTextFile(
      `${cwd}/broken_test.ts`,
      'Deno.test("compile error", () => { const count: number = "not a number"; });\n',
    );
    const result = await validateRepositoryForPublication(cwd, {
      run: shellRunner(),
    });
    assertEquals(result.status, "failed");
    if (result.status === "failed") {
      assert(result.output.includes("Type 'string' is not assignable"));
    }
  } finally {
    await Deno.remove(cwd, { recursive: true });
  }
});

Deno.test("publication validation identifies unavailable dependency services", async () => {
  const cwd = await checkout(
    "#!/bin/sh\necho 'error: failed to download from dependency service' >&2\nexit 1\n",
  );
  try {
    const result = await validateRepositoryForPublication(cwd, {
      run: shellRunner(),
    });
    assertEquals(result.status, "unavailable");
    if (result.status === "unavailable") {
      assert(result.reason.includes("failed to download"));
      assert(result.reason.startsWith("[PUBLICATION_VALIDATION_UNAVAILABLE]"));
    }
    await Deno.writeTextFile(`${cwd}/quality.sh`, "#!/bin/sh\nexit 0\n");
    const resumed = await validateRepositoryForPublication(cwd, {
      run: shellRunner(),
    });
    assertEquals(resumed.status, "passed");
  } finally {
    await Deno.remove(cwd, { recursive: true });
  }
});

Deno.test("publication validation classifies an observed JSR manifest outage", async () => {
  const cwd = await checkout("#!/bin/sh\nexit 0\n");
  try {
    const result = await validateRepositoryForPublication(cwd, {
      run: async () => ({
        ok: true,
        value: {
          success: false,
          code: 1,
          stdout: "",
          stderr:
            "JSR package manifest for '@std/crypto' failed to load. Import 'https://jsr.io/@std/crypto/meta.json' failed.",
          timedOut: false,
        },
      }),
    });
    assertEquals(result.status, "unavailable");
    if (result.status === "unavailable") {
      assert(result.reason.includes("JSR package manifest"));
    }
  } finally {
    await Deno.remove(cwd, { recursive: true });
  }
});

Deno.test("publication validation treats skipped strict checks as unavailable", async () => {
  const cwd = await checkout("#!/bin/sh\nexit 0\n");
  try {
    const result = await validateRepositoryForPublication(cwd, {
      run: async () => ({
        ok: true,
        value: {
          success: false,
          code: 1,
          stdout:
            "checkov: SKIPPED (not run — no checkov on PATH)\nResult: FAILED (strict mode — skipped checks are not allowed)",
          stderr: "",
          timedOut: false,
        },
      }),
    });
    assertEquals(result.status, "unavailable");
    if (result.status === "unavailable") {
      assert(result.reason.includes("no checkov on PATH"));
    }
  } finally {
    await Deno.remove(cwd, { recursive: true });
  }
});

Deno.test("publication validation treats inaccessible checkouts as unavailable", async () => {
  const cwd = await checkout("#!/bin/sh\nexit 0\n");
  try {
    const result = await validateRepositoryForPublication(cwd, {
      run: async () => ({
        ok: true,
        value: {
          success: false,
          code: 1,
          stdout: "type check passed\n" +
            "untrusted account cannot use '/tmp/checkout' (probe 1) — left to CI",
          stderr: "",
          timedOut: false,
        },
      }),
    });
    assertEquals(result.status, "unavailable");
    if (result.status === "unavailable") {
      assert(result.reason.includes("untrusted account cannot use"));
    }
  } finally {
    await Deno.remove(cwd, { recursive: true });
  }
});

Deno.test("publication failure classification handles a long non-match", async () => {
  const cwd = await checkout("#!/bin/sh\nexit 0\n");
  try {
    const result = await validateRepositoryForPublication(cwd, {
      run: async () => ({
        ok: true,
        value: {
          success: false,
          code: 1,
          stdout: `strict mode ${
            "x".repeat(100_000)
          } ended without the skip summary`,
          stderr: "",
          timedOut: false,
        },
      }),
    });
    assertEquals(result.status, "failed");
  } finally {
    await Deno.remove(cwd, { recursive: true });
  }
});

Deno.test("publication failure classifier rejects a long partial JSR message", async () => {
  const cwd = await checkout("#!/bin/sh\nexit 0\n");
  try {
    const result = await validateRepositoryForPublication(cwd, {
      run: async () => ({
        ok: true,
        value: {
          success: false,
          code: 1,
          stdout: `JSR package manifest ${"x".repeat(100_000)} not failed to load`,
          stderr: "",
          timedOut: false,
        },
      }),
    });
    assertEquals(result.status, "failed");
  } finally {
    await Deno.remove(cwd, { recursive: true });
  }
});

Deno.test("publication failures retain the command's cause in long output", async () => {
  const cwd = await checkout("#!/bin/sh\nexit 0\n");
  try {
    const result = await validateRepositoryForPublication(cwd, {
      run: async () => ({
        ok: true,
        value: {
          success: false,
          code: 1,
          stdout: `failing check: unresolved dependency\n${"x".repeat(20_000)}`,
          stderr: "",
          timedOut: false,
        },
      }),
    });
    assertEquals(result.status, "failed");
    if (result.status === "failed") {
      assert(result.output.includes("unresolved dependency"));
    }
  } finally {
    await Deno.remove(cwd, { recursive: true });
  }
});

Deno.test("publication validation binds a pass to the exact tree", async () => {
  const cwd = await checkout("#!/bin/sh\nexit 0\n");
  try {
    const result = await validateRepositoryForPublication(cwd, {
      run: shellRunner(),
    });
    assertEquals(result.status, "passed");
    assert(await publicationValidationIsCurrent(result, cwd));
    await Deno.writeTextFile(
      `${cwd}/new-test.ts`,
      "// changed after validation\n",
    );
    assertEquals(await publicationValidationIsCurrent(result, cwd), false);
  } finally {
    await Deno.remove(cwd, { recursive: true });
  }
});

Deno.test("publication validation cannot pass when its command was not run", async () => {
  const cwd = await checkout("#!/bin/sh\nexit 0\n");
  try {
    let calls = 0;
    const result = await validateRepositoryForPublication(cwd, {
      run: async () => {
        calls++;
        return { ok: false, error: new Error("command could not start") };
      },
    });
    assertEquals(calls, 1);
    assertEquals(result.status, "unavailable");
  } finally {
    await Deno.remove(cwd, { recursive: true });
  }
});

Deno.test("publication tree identity includes committed and untracked inputs", async () => {
  const cwd = await checkout("#!/bin/sh\nexit 0\n");
  try {
    const before = await publicationTreeIdentity(cwd);
    await Deno.writeTextFile(`${cwd}/new-test.ts`, "Deno.test(() => {});\n");
    const after = await publicationTreeIdentity(cwd);
    assert(before !== null && after !== null);
    assert(before !== after);
  } finally {
    await Deno.remove(cwd, { recursive: true });
  }
});
