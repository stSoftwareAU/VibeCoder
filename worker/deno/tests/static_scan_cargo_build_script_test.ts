/**
 * Behavioural fixture for the static best-practices scan's build-tool guard
 * (Issue #4415).
 *
 * A minimal offline Rust project carries a `build.rs` that writes a sentinel
 * file when it runs, and a static finding the scan should report. The real
 * `defaultRunScan` is called with an injected `runClaudeFn` that captures the
 * options the scan passes to Claude and plays the agent: each command the
 * agent wants is checked by the scan's own hook decision, and run only when
 * allowed.
 *
 * The scan must refuse `cargo check` and `cargo clippy` (so the sentinel is
 * never written and no `target/` appears), let `grep` read the source, and
 * finish ok with the finding as evidence.
 *
 * The positive control runs `cargo check --offline` in a fresh copy with no
 * guard, and must write the sentinel and `target/`. That proves the fixture is
 * live: the absence above is the guard's doing, not a broken project.
 *
 * The control needs `cargo` on PATH. On a host without it the control is
 * ignored and reports as ignored, not passed; the fixture test above does not
 * depend on cargo.
 *
 * Uses Australian English throughout (behaviour, artefacts, organisation, etc.).
 */

import {
  assert,
  assertEquals,
  assertMatch,
  assertStringIncludes,
} from "@std/assert";
import {
  defaultRunScan,
  type RunScanOptions,
} from "../lib/idle_task_templates/best_practices_template.ts";
import { runIdleTaskClaude } from "../lib/idle_task_claude_budget.ts";
import {
  decideStaticScanHook,
  STATIC_SCAN_DENIAL_MARKER,
} from "../lib/static_scan_guard.ts";

const SENTINEL = "build-hook-ran";

/** The project the fixture builds: no dependencies, offline by construction. */
const CARGO_TOML = `[package]
name = "static-scan-fixture"
version = "0.1.0"
edition = "2021"

[dependencies]
`;

/** Writes the sentinel when cargo runs the build script. */
const BUILD_RS = `fn main() {
    let dir = std::env::var("CARGO_MANIFEST_DIR").unwrap();
    std::fs::write(std::path::Path::new(&dir).join("${SENTINEL}"), "ran\\n").unwrap();
}
`;

/** One obvious static finding: an unchecked `unwrap` on a slice index. */
const LIB_RS = `pub fn first(v: &[u8]) -> u8 {
    v.get(0).copied().unwrap()
}
`;

/** Lay the fixture down in a directory the caller owns. */
async function writeFixture(root: string): Promise<void> {
  await Deno.mkdir(`${root}/src`, { recursive: true });
  await Deno.writeTextFile(`${root}/Cargo.toml`, CARGO_TOML);
  await Deno.writeTextFile(`${root}/build.rs`, BUILD_RS);
  await Deno.writeTextFile(`${root}/src/lib.rs`, LIB_RS);
}

/** Whether a path exists, without throwing. */
async function exists(path: string): Promise<boolean> {
  try {
    await Deno.stat(path);
    return true;
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return false;
    throw error;
  }
}

/** Whether `cargo` runs on this host's PATH. */
async function cargoOnPath(): Promise<boolean> {
  try {
    const out = await new Deno.Command("cargo", {
      args: ["--version"],
      stdout: "null",
      stderr: "null",
    }).output();
    return out.success;
  } catch {
    return false;
  }
}

const HAVE_CARGO = await cargoOnPath();

/** What the fake agent did with one command. */
interface Outcome {
  command: string;
  denied: boolean;
  reason?: string;
  code?: number;
  stdout?: string;
}

/** The commands the fake agent wants to run, in order. */
const AGENT_COMMANDS = [
  "cargo check --offline",
  "cargo clippy --offline",
  "grep -Hn unwrap src/lib.rs",
];

Deno.test("static scan fixture - the scan refuses cargo, runs grep, and reports the finding (Issue #4415)", async () => {
  const root = await Deno.makeTempDir({ prefix: "vibe-static-scan-" });
  try {
    await writeFixture(root);

    // An array rather than a `let`: TypeScript narrows a variable assigned
    // only inside a closure to `undefined`, which would hide the captured call.
    const calls: Parameters<typeof runIdleTaskClaude>[0][] = [];
    const outcomes: Outcome[] = [];

    const fakeClaude: typeof runIdleTaskClaude = async (options) => {
      calls.push(options);
      for (const command of AGENT_COMMANDS) {
        const decision = decideStaticScanHook({
          hook_event_name: "PreToolUse",
          tool_name: "Bash",
          tool_input: { command },
        });
        if (decision.deny) {
          outcomes.push({ command, denied: true, reason: decision.reason });
          continue;
        }
        // Pin cargo's output to the project's own target/, so an unguarded
        // build would be visible there whatever the host's CARGO_TARGET_DIR.
        const out = await new Deno.Command("sh", {
          args: ["-c", command],
          cwd: options.cwd,
          env: { CARGO_TARGET_DIR: `${options.cwd}/target` },
          stdout: "piped",
          stderr: "piped",
        }).output();
        outcomes.push({
          command,
          denied: false,
          code: out.code,
          stdout: new TextDecoder().decode(out.stdout),
        });
      }
      return { ok: true, value: { exitCode: 0, timedOut: false, output: "" } };
    };

    const opts: RunScanOptions = {
      repo: "owner/static-scan-fixture",
      workDir: root,
      bucket: "rust",
      knownOpenFindingIds: [],
      openIssueTitles: [],
      suppressedIds: [],
    };
    const result = await defaultRunScan(
      opts,
      async () => ({ ok: true, value: "Scan bucket {{BUCKET}}." }),
      async () => "Bucket guide.",
      fakeClaude,
    );

    // The scan's own call to Claude: the write tools and the build tools are
    // both refused, and the hook that classifies Bash is installed.
    assertEquals(calls.length, 1, "defaultRunScan must call Claude once");
    const captured = calls[0]!;
    const disallowed = captured.disallowedTools ?? [];
    assert(disallowed.includes("Bash(cargo:*)"), "cargo must be disallowed");
    for (const tool of ["Write", "Edit", "MultiEdit", "NotebookEdit"]) {
      assert(disallowed.includes(tool), `${tool} must stay disallowed`);
    }
    const settings = JSON.parse(captured.settingsJson ?? "{}") as {
      hooks?: {
        PreToolUse?: { matcher: string; hooks: { command: string }[] }[];
      };
    };
    const hook = settings.hooks?.PreToolUse?.[0];
    assertEquals(hook?.matcher, "Bash");
    assertStringIncludes(hook!.hooks[0]!.command, "static_scan_guard_cli.ts");

    // Nothing that cargo would run happened: no build script, no target/.
    // Checked first, because it is the property the guard exists to hold.
    assertEquals(
      await exists(`${root}/${SENTINEL}`),
      false,
      "the build script must not have run",
    );
    assertEquals(
      await exists(`${root}/target`),
      false,
      "no target/ may be written",
    );

    // The two build tools were refused by the guard, with its marker.
    const cargoCheck = outcomes.find((o) =>
      o.command === "cargo check --offline"
    );
    const cargoClippy = outcomes.find((o) =>
      o.command === "cargo clippy --offline"
    );
    assert(cargoCheck?.denied, "cargo check must be denied");
    assert(cargoClippy?.denied, "cargo clippy must be denied");
    assert(cargoCheck.reason?.startsWith(STATIC_SCAN_DENIAL_MARKER));
    assert(cargoClippy.reason?.startsWith(STATIC_SCAN_DENIAL_MARKER));

    // The static read ran and produced the evidence the scan needs.
    const grep = outcomes.find((o) =>
      o.command === "grep -Hn unwrap src/lib.rs"
    );
    assert(grep !== undefined && !grep.denied, "grep must be allowed");
    assertEquals(grep.code, 0);
    assertMatch(grep.stdout ?? "", /src\/lib\.rs:\d+:.*unwrap/);

    // The scan itself finished ok.
    assertEquals(result, { ok: true, value: true });
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test({
  name:
    "static scan fixture control - cargo check without the guard writes the sentinel and target/ (Issue #4415)",
  ignore: !HAVE_CARGO,
  fn: async () => {
    const root = await Deno.makeTempDir({
      prefix: "vibe-static-scan-control-",
    });
    try {
      await writeFixture(root);
      const out = await new Deno.Command("cargo", {
        args: ["check", "--offline"],
        cwd: root,
        env: { CARGO_TARGET_DIR: `${root}/target` },
        stdout: "piped",
        stderr: "piped",
      }).output();
      const stderr = new TextDecoder().decode(out.stderr);
      assertEquals(out.code, 0, `cargo check failed: ${stderr}`);
      assertEquals(
        await exists(`${root}/${SENTINEL}`),
        true,
        "the build script must run when cargo is not guarded",
      );
      assertEquals(
        await exists(`${root}/target`),
        true,
        "cargo must write target/ when it is not guarded",
      );
    } finally {
      await Deno.remove(root, { recursive: true });
    }
  },
});
