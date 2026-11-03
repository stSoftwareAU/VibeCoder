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
    const child = new Deno.Command(executable, {
      args: [...args],
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
          stdout: `JSR package manifest ${
            "x".repeat(100_000)
          } not failed to load`,
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

Deno.test("publication classification keeps an assertion failure despite a passing negative test name", async () => {
  const cwd = await checkout(
    "#!/bin/sh\nexec deno test --no-config --no-lock example_test.ts\n",
  );
  try {
    await Deno.writeTextFile(
      `${cwd}/example_test.ts`,
      'Deno.test("node not installed is handled", () => {});\nDeno.test("regression", () => { throw new Error("actual regression"); });\n',
    );
    const result = await validateRepositoryForPublication(cwd, {
      run: shellRunner(),
    });
    assertEquals(result.status, "failed");
  } finally {
    await Deno.remove(cwd, { recursive: true });
  }
});

Deno.test("publication classification handles many repeated strict prefixes in linear time", async () => {
  const cwd = await checkout("#!/bin/sh\nexit 0\n");
  try {
    const started = performance.now();
    const result = await validateRepositoryForPublication(cwd, {
      identity: async () => "fixture",
      run: async () => ({
        ok: true,
        value: {
          success: false,
          code: 1,
          stdout: "strict mode ".repeat(32_000),
          stderr: "",
          timedOut: false,
        },
      }),
    });
    assertEquals(result.status, "failed");
    assert(
      performance.now() - started < 500,
      "repeated prefixes must not cause quadratic scans",
    );
  } finally {
    await Deno.remove(cwd, { recursive: true });
  }
});

Deno.test("publication validation rejects empty Deno execution even with a zero exit", async () => {
  const cwd = await checkout(
    "#!/bin/sh\nexec deno test --no-config --no-lock --filter=absent example_test.ts\n",
  );
  try {
    await Deno.writeTextFile(
      `${cwd}/example_test.ts`,
      'Deno.test("required regression", () => { throw new Error("regression"); });\n',
    );
    const result = await validateRepositoryForPublication(cwd, {
      run: shellRunner(),
    });
    assertEquals(result.status, "failed");
    if (result.status === "failed") assert(result.output.includes("execut"));
  } finally {
    await Deno.remove(cwd, { recursive: true });
  }
});

Deno.test("publication uses a configured gate with its flags and binds that command", async () => {
  const cwd = await checkout("#!/bin/sh\nexit 99\n");
  try {
    await Deno.remove(`${cwd}/quality.sh`);
    await Deno.writeTextFile(
      `${cwd}/verify.sh`,
      '#!/bin/sh\ntest "$1" = custom-flag || exit 7\ntest -f verify.sh || exit 8\n',
    );
    const result = await validateRepositoryForPublication(cwd, {
      command: "sh ./verify.sh custom-flag",
      run: shellRunner(),
    });
    assertEquals(result.status, "passed");
    assert(await publicationValidationIsCurrent(result, cwd));
    const other = await validateRepositoryForPublication(cwd, {
      command: "sh ./verify.sh wrong-flag",
      run: shellRunner(),
    });
    assertEquals(other.status, "failed");
    assert(
      result.identity !== other.identity,
      "command and flags must be bound to the identity",
    );
  } finally {
    await Deno.remove(cwd, { recursive: true });
  }
});

Deno.test("publication retains a substantive failure alongside unavailable dependencies", async () => {
  const cwd = await checkout(
    "#!/bin/sh\necho 'error: failed to download from service' >&2\necho 'FAILED | 1 passed | 1 failed'\nexit 1\n",
  );
  try {
    const result = await validateRepositoryForPublication(cwd, {
      run: shellRunner(),
    });
    assertEquals(result.status, "failed");
    if (result.status === "failed") {
      assert(result.output.includes("failed to download"));
      assert(result.output.includes("1 failed"));
    }
  } finally {
    await Deno.remove(cwd, { recursive: true });
  }
});

for (const task of ["test:unit", "test"]) {
  Deno.test(`publication executes the full ${task} selection after a misleading impacted gate`, async () => {
    const cwd = await checkout(
      "#!/bin/sh\nexec deno test --no-config --no-lock --filter=passing first_test.ts\n",
    );
    try {
      await Deno.writeTextFile(
        `${cwd}/deno.json`,
        JSON.stringify({ tasks: { [task]: "deno test --no-lock" } }),
      );
      await Deno.writeTextFile(
        `${cwd}/first_test.ts`,
        'Deno.test("passing", () => {}); Deno.test("excluded", () => {});\n',
      );
      await Deno.writeTextFile(
        `${cwd}/required_test.ts`,
        'Deno.test("required regression", () => { throw new Error("required regression"); });\n',
      );
      const failed = await validateRepositoryForPublication(cwd, {
        run: shellRunner(),
      });
      assertEquals(failed.status, "failed");
      if (failed.status === "failed") {
        assert(failed.output.includes("required regression"));
      }
      await Deno.writeTextFile(
        `${cwd}/required_test.ts`,
        'Deno.test("required regression", () => {});\n',
      );
      const passed = await validateRepositoryForPublication(cwd, {
        run: shellRunner(),
      });
      assertEquals(passed.status, "passed");
      if (passed.status === "passed") {
        assertEquals(passed.deno?.[0]?.executedTests, 3);
      }
    } finally {
      await Deno.remove(cwd, { recursive: true });
    }
  });
}

Deno.test("publication counts real Deno test steps", async () => {
  const cwd = await checkout("#!/bin/sh\nexit 0\n");
  try {
    await Deno.writeTextFile(
      `${cwd}/deno.json`,
      JSON.stringify({ tasks: { test: "deno test --no-lock" } }),
    );
    await Deno.writeTextFile(
      `${cwd}/test.ts`,
      'Deno.test("steps", async (t) => { await t.step("one", () => {}); });',
    );
    const result = await validateRepositoryForPublication(cwd, {
      run: shellRunner(),
    });
    assertEquals(result.status, "passed");
    if (result.status === "passed") {
      assertEquals(result.deno?.[0]?.executedTests, 1);
    }
  } finally {
    await Deno.remove(cwd, { recursive: true });
  }
});

Deno.test("publication preserves taskless repository test permissions and selection", async () => {
  const cwd = await checkout(
    "#!/bin/sh\nexec deno test --allow-read --no-lock selected_test.ts\n",
  );
  try {
    await Deno.writeTextFile(`${cwd}/deno.json`, "{}");
    await Deno.writeTextFile(
      `${cwd}/selected_test.ts`,
      'Deno.test("read", () => { Deno.readTextFileSync("deno.json"); });',
    );
    await Deno.writeTextFile(
      `${cwd}/excluded_test.ts`,
      'Deno.test("excluded performance fixture", () => { throw new Error("not a required test"); });',
    );
    const result = await validateRepositoryForPublication(cwd, {
      run: shellRunner(),
    });
    assertEquals(result.status, "passed");
  } finally {
    await Deno.remove(cwd, { recursive: true });
  }
});

Deno.test("publication leaves non-Deno JavaScript tests on their own gate", async () => {
  const cwd = await checkout("#!/bin/sh\nexit 0\n");
  try {
    await Deno.writeTextFile(
      `${cwd}/example.test.js`,
      'test("framework owned", () => {});',
    );
    let calls = 0;
    const run = shellRunner();
    const result = await validateRepositoryForPublication(cwd, {
      run: (...args) => {
        calls++;
        return run(...args);
      },
    });
    assertEquals(result.status, "passed");
    assertEquals(calls, 1);
  } finally {
    await Deno.remove(cwd, { recursive: true });
  }
});

Deno.test("publication default preserves the repository gate flags", async () => {
  const cwd = await checkout('#!/bin/sh\n[ "$#" -eq 0 ]\n');
  try {
    const result = await validateRepositoryForPublication(cwd, {
      run: shellRunner(),
    });
    assertEquals(result.status, "passed");
  } finally {
    await Deno.remove(cwd, { recursive: true });
  }
});

Deno.test("publication missing executable defers and then recovers", async () => {
  const cwd = await checkout(
    "#!/bin/sh\nexec publication-check-tool-that-does-not-exist\n",
  );
  try {
    const result = await validateRepositoryForPublication(cwd, {
      run: shellRunner(),
    });
    assertEquals(result.status, "unavailable");
    await Deno.writeTextFile(`${cwd}/quality.sh`, "#!/bin/sh\nexit 0\n");
    assertEquals(
      (await validateRepositoryForPublication(cwd, { run: shellRunner() }))
        .status,
      "passed",
    );
    await Deno.remove(`${cwd}/quality.sh`);
    assertEquals(
      (await validateRepositoryForPublication(cwd, { run: shellRunner() }))
        .status,
      "unavailable",
    );
  } finally {
    await Deno.remove(cwd, { recursive: true });
  }
});

Deno.test("publication uses complete gate permissions instead of a narrower manifest task", async () => {
  const cwd = await checkout("#!/bin/sh\nexec deno test -A --no-lock\n");
  try {
    await Deno.writeTextFile(
      `${cwd}/deno.json`,
      JSON.stringify({ tasks: { test: "deno test --allow-read --no-lock" } }),
    );
    await Deno.writeTextFile(
      `${cwd}/permissions_test.ts`,
      `Deno.test("requires write and run", async () => {
      const path = await Deno.makeTempFile();
      await Deno.remove(path);
      const result = await new Deno.Command("bash", {args: ["-c", "true"]}).output();
      if (!result.success) throw new Error("bash failed");
    });`,
    );
    const result = await validateRepositoryForPublication(cwd, {
      run: shellRunner(),
    });
    assertEquals(result.status, "passed");
    const narrow = await shellRunner()("deno", ["task", "test"], {
      cwd,
      timeoutMs: 10000,
    });
    assert(narrow.ok && narrow.value.code !== 0);
  } finally {
    await Deno.remove(cwd, { recursive: true });
  }
});
