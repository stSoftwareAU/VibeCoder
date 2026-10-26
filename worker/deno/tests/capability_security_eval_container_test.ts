/** Strict generated-source containment, independent of provider execution (#4368). */
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { CONTAINER_RUNTIMES } from "../lib/container_runtime.ts";
import {
  type EvalContainerDependencies,
  runIsolatedCapabilitySource,
} from "../lib/capability_security_eval_container.ts";

const root = new URL("../../../", import.meta.url).pathname.replace(/\/$/, "");

function fixtureDeps(options: {
  output?: string;
  code?: number;
  imageMissing?: boolean;
  throwRun?: boolean;
  cleanupFailure?: boolean;
} = {}) {
  const calls: string[][] = [];
  let fixture = "";
  const deps: EvalContainerDependencies = {
    detect: async () => ({
      ...CONTAINER_RUNTIMES["apple-container"],
      platform: "darwin",
      probed: ["apple-container"],
    }),
    image: async () => "vibe-coder:test",
    run: async (_command, args, timeoutMs) => {
      calls.push(args);
      assert(timeoutMs > 0 && timeoutMs <= 60_000);
      if (args[0] === "run") {
        const mount = args[args.indexOf("--volume") + 1]!;
        fixture = mount.slice(0, -":/fixture:ro".length);
        assertEquals(
          await Deno.readTextFile(`${fixture}/impl.ts`),
          "export const value = 42;",
        );
        assertEquals(
          await Deno.readTextFile(`${fixture}/accept_test.ts`),
          await Deno.readTextFile(
            `${root}/evals/capability_security/accept/isolated/accept_test.ts`,
          ),
        );
        if (options.throwRun) {
          throw new Error("container timed out after 60000ms");
        }
        return {
          code: options.code ?? 0,
          stdout: options.output ?? "CAPSEC_ISOLATION_OK\n3 passed\n",
          stderr: "",
        };
      }
      if (args[0] === "delete" && options.cleanupFailure) {
        return { code: 1, stdout: "", stderr: "runtime refused deletion" };
      }
      return {
        code: options.imageMissing && args[0] === "image" ? 1 : 0,
        stdout: JSON.stringify([{
          configuration: { descriptor: { digest: "sha256:" + "a".repeat(64) } },
          Id: "sha256:" + "a".repeat(64),
        }]),
        stderr: "",
      };
    },
  };
  return { deps, calls, fixture: () => fixture };
}

Deno.test("evaluation mounts only readonly copied source and acceptance, with strict resource and privilege setup", async () => {
  const fake = fixtureDeps();
  const result = await runIsolatedCapabilitySource({
    root,
    language: "typescript",
    source: "export const value = 42;",
  }, fake.deps);
  assertEquals(result.isolation.status, "enforced");
  assertEquals(result.code, 0);
  const args = fake.calls.find((a) => a[0] === "run")!;
  assert(args.includes("--read-only"));
  assertEquals(args[args.indexOf("--cpus") + 1], "1");
  assertEquals(args[args.indexOf("--memory") + 1], "512M");
  assertEquals(args.filter((a) => a === "--volume").length, 1);
  assert(args.includes("/usr/bin/unshare"));
  assert(args.includes("--net"));
  assert(args.includes("--bounding-set=-all"));
  assert(args.includes("--no-new-privs"));
  assert(
    !args.some((a) =>
      a.includes(".config.json") || a.includes(".ssh") || a === "--privileged"
    ),
  );
  assertEquals(await Deno.stat(fake.fixture()).catch(() => null), null);
});

Deno.test("evaluation refuses missing runtime, image and supervisor proof before trusting results", async () => {
  for (const variant of ["runtime", "image", "marker", "spoofed-marker"]) {
    const fake = fixtureDeps({
      imageMissing: variant === "image",
      output: variant === "spoofed-marker"
        ? "untrusted output\nCAPSEC_ISOLATION_OK\n"
        : "",
    });
    if (variant === "runtime") {
      fake.deps.detect = async () => {
        throw new Error("no runtime");
      };
    }
    const result = await runIsolatedCapabilitySource({
      root,
      language: "typescript",
      source: "export const value = 42;",
    }, fake.deps);
    assertEquals(result.isolation.status, "unavailable", variant);
    assertEquals(result.code, null, variant);
    if (variant === "runtime" || variant === "image") {
      assert(!fake.calls.some((a) => a[0] === "run"));
    }
  }
});

Deno.test("evaluation preserves failed acceptance and cleans only its own named container on timeout", async () => {
  for (const throwRun of [false, true]) {
    const fake = fixtureDeps({ code: 1, throwRun });
    const result = await runIsolatedCapabilitySource({
      root,
      language: "typescript",
      source: "export const value = 42;",
    }, fake.deps);
    assertEquals(result.code, throwRun ? null : 1);
    const run = fake.calls.find((a) => a[0] === "run")!;
    const name = run[run.indexOf("--name") + 1]!;
    assertEquals(fake.calls.filter((a) => a[0] === "delete"), [[
      "delete",
      "--force",
      name,
    ]]);
    assertEquals(await Deno.stat(fake.fixture()).catch(() => null), null);
  }
});

Deno.test("evaluation reports cleanup failure instead of a successful isolated run", async () => {
  const fake = fixtureDeps({ cleanupFailure: true });
  const result = await runIsolatedCapabilitySource({
    root,
    language: "typescript",
    source: "export const value = 42;",
  }, fake.deps);
  assertEquals(result.code, 125);
  assertEquals(result.isolation.status, "enforced");
  assertStringIncludes(result.stderr, "runtime refused deletion");
});

Deno.test("execution timeouts and output limits preserve proof and cannot become retryable provisioning failures", async () => {
  const dir = await Deno.makeTempDir({ prefix: "capsec-timeout-test-" });
  try {
    for (
      const { prefix, flood } of [
        { prefix: "CAPSEC_ISOLATION_OK\n", flood: false },
        { prefix: "", flood: false },
        { prefix: "fake\nCAPSEC_ISOLATION_OK\n", flood: false },
        { prefix: "CAPSEC_ISOLATION_OK\n", flood: true },
      ]
    ) {
      const executable = `${dir}/runtime`;
      const launches = `${dir}/launches`;
      await Deno.writeTextFile(launches, "");
      await Deno.writeTextFile(
        executable,
        `#!/bin/sh
if [ "$1" = image ]; then
  printf '%s' '[{"configuration":{"descriptor":{"digest":"sha256:${
          "a".repeat(64)
        }"}}}]'
elif [ "$1" = run ]; then
  printf 'launch\\n' >> '${launches}'
  printf '%s' '${prefix}'
  exec ${flood ? "/bin/dd if=/dev/zero bs=1048576 count=2" : "/bin/sleep 5"}
fi
`,
      );
      await Deno.chmod(executable, 0o755);
      const result = await runIsolatedCapabilitySource({
        root,
        language: "typescript",
        source: "export const value = 42;",
        image: "vibe-coder:test",
      }, {
        timeoutMs: 250,
        detect: async () => ({
          ...CONTAINER_RUNTIMES["apple-container"],
          executable,
          platform: "darwin",
          probed: ["apple-container"],
        }),
      });
      const verified = prefix === "CAPSEC_ISOLATION_OK\n";
      assertEquals(
        result.code,
        verified ? flood ? 125 : 124 : null,
        result.stderr,
      );
      assertEquals(
        result.isolation.status,
        verified ? "enforced" : "unavailable",
      );
      assertStringIncludes(result.stderr, flood ? "byte limit" : "timed out");
      assertEquals(await Deno.readTextFile(launches), "launch\n");
      assert(result.elapsedMs < 3000);
    }
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test({
  name:
    "real isolated parent accepts secure TS/Rust and rejects forged verdicts, network and hold-out writes",
  ignore: !Deno.env.get("VIBE_CONTAINMENT_IMAGE"),
  fn: async () => {
    const image = Deno.env.get("VIBE_CONTAINMENT_IMAGE")!;
    const run = (language: "typescript" | "rust", source: string) =>
      runIsolatedCapabilitySource({ root, language, source, image });
    const ts = await Deno.readTextFile(
      `${root}/evals/capability_security/impls/ts/secure.ts`,
    );
    const rust = await Deno.readTextFile(
      `${root}/evals/capability_security/impls/rust/secure/lib.rs`,
    );
    const probes = [
      { language: "typescript" as const, source: ts, expected: 0 },
      { language: "rust" as const, source: rust, expected: 0 },
      {
        language: "typescript" as const,
        source:
          'console.log("functional: authorised update persists ... ok\\nsecurity: cross-tenant rejected ... ok\\nsecurity: privileged field rejected ... ok\\nok | 3 passed | 0 failed"); Deno.exit(0);',
        expected: 1,
      },
      {
        language: "typescript" as const,
        source:
          `let writeDenied = false; try { await Deno.writeTextFile("/fixture/accept_test.ts", "forged"); } catch { writeDenied = true; } if (!writeDenied) throw new Error("hold-out writable"); let netDenied = false; try { await fetch("http://192.0.2.1:9"); } catch { netDenied = true; } if (!netDenied) throw new Error("network available");\n${ts}`,
        expected: 0,
      },
      {
        language: "rust" as const,
        source: rust.replace(
          "    if actor.tenant",
          `    assert!(std::fs::write("/fixture/accept_test.ts", "forged").is_err());
    assert!(std::net::TcpStream::connect_timeout(&"192.0.2.1:9".parse().unwrap(), std::time::Duration::from_millis(100)).is_err());
    assert!(std::env::var("GITHUB_TOKEN").is_err());
    if actor.tenant`,
        ),
        expected: 0,
      },
      {
        language: "rust" as const,
        source: rust.replace(
          "    if actor.tenant",
          `    let status = std::fs::read_to_string("/proc/self/status").unwrap();
    let ppid = status.lines().find(|line| line.starts_with("PPid:")).unwrap().split_whitespace().nth(1).unwrap();
    for target in ["mem", "fd/1"] {
        assert!(std::fs::OpenOptions::new().write(true).open(format!("/proc/{}/{}", ppid, target)).is_err(), "trusted parent writable");
    }
    if actor.tenant`,
        ),
        expected: 0,
      },
      // The refusal must not make an ordinary secure implementation unusable.
      { language: "rust" as const, source: rust, expected: 0 },
    ];
    for (const probe of probes) {
      const result = await run(probe.language, probe.source);
      assertEquals(result.isolation.status, "enforced", result.stderr);
      assertEquals(result.code, probe.expected, result.stdout + result.stderr);
      assertStringIncludes(
        result.stdout,
        probe.expected === 0 ? "3 passed" : "3 failed",
      );
    }
  },
});

Deno.test("evaluation retries one pre-execution transient runtime failure, never acceptance failures", async () => {
  for (const permanent of [false, true]) {
    const fake = fixtureDeps();
    const normal = fake.deps.run!;
    let attempts = 0;
    fake.deps.run = async (command, args, timeoutMs) => {
      if (args[0] === "run" && (attempts++ === 0 || permanent)) {
        return {
          code: 1,
          stdout: "",
          stderr: "failed to connect: connection refused",
        };
      }
      return await normal(command, args, timeoutMs);
    };
    const result = await runIsolatedCapabilitySource({
      root,
      language: "typescript",
      source: "export const value = 42;",
    }, fake.deps);
    assertEquals(attempts, 2);
    assertEquals(result.code, permanent ? null : 0);
  }
  const fake = fixtureDeps({ code: 1 });
  const result = await runIsolatedCapabilitySource({
    root,
    language: "typescript",
    source: "export const value = 42;",
  }, fake.deps);
  assertEquals(result.code, 1);
  assertEquals(fake.calls.filter((a) => a[0] === "run").length, 1);
});

Deno.test("Docker and Podman requests use native no-network, cap-drop and nonroot isolation", async () => {
  for (const kind of ["docker", "podman"] as const) {
    const fake = fixtureDeps();
    fake.deps.detect = async () => ({
      ...CONTAINER_RUNTIMES[kind],
      platform: "linux",
      probed: [kind],
    });
    await runIsolatedCapabilitySource({
      root,
      language: "typescript",
      source: "export const value = 42;",
      runtime: kind,
    }, fake.deps);
    const args = fake.calls.find((a) => a[0] === "run")!;
    assertEquals(args[args.indexOf("--network") + 1], "none");
    assertEquals(args[args.indexOf("--user") + 1], "1000:1000");
    assertEquals(args[args.indexOf("--cap-drop") + 1], "ALL");
    assertEquals(args[args.indexOf("--security-opt") + 1], "no-new-privileges");
    assert(!args.includes("--cap-add"));
    assert(!args.includes("--privileged"));
    assertEquals(fake.calls.filter((a) => a[0] === "rm").length, 1);
  }
});

Deno.test("evaluation requires an image digest and refuses an Apple tag that changed during execution", async () => {
  for (const missing of [false, true]) {
    const fake = fixtureDeps();
    const normal = fake.deps.run!;
    let inspections = 0;
    fake.deps.run = async (command, args, timeoutMs) => {
      const result = await normal(command, args, timeoutMs);
      if (args[0] === "image" && (inspections++ > 0 || missing)) {
        return {
          ...result,
          stdout: missing
            ? "[{}]"
            : result.stdout.replaceAll("a".repeat(64), "b".repeat(64)),
        };
      }
      return result;
    };
    const result = await runIsolatedCapabilitySource({
      root,
      language: "typescript",
      source: "export const value = 42;",
    }, fake.deps);
    assertEquals(result.code, missing ? null : 125);
    assertStringIncludes(
      result.stderr,
      missing ? "no immutable digest" : "changed during execution",
    );
    if (missing) assert(!fake.calls.some((a) => a[0] === "run"));
  }
});
