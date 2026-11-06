/**
 * Regression test for Issue #4683 — the `cargo-audit` and `cargo-upgrade`
 * workflows installed their crate with a bare `cargo install`, so the crate
 * was resolved at run time and sat outside the repository's 24-hour
 * dependency quarantine. Renovate's cargo manager never sees `run:` steps,
 * so nothing bumped the pin either.
 *
 * Each workflow must install its crate with
 * `cargo install --locked <crate> --version x.y.z`, in both the fleet
 * template (`WORKFLOW_SPECS` in `lib/workflow_definitions.ts`) and this
 * repository's own `.github/workflows/` copy. The Renovate `crate`
 * customManager in `renovate.json` must keep those pins current.
 *
 * Australian English throughout (behaviour, organisation).
 */

import { assert, assertEquals } from "@std/assert";
import { parse as parseYaml } from "@std/yaml/parse";
import { findUnpinnedInstalls } from "../lib/ci_install_pin_scanner.ts";
import { WORKFLOW_SPECS } from "../lib/workflow_definitions.ts";

/** Resolve the repository root (three levels up from worker/deno/tests/). */
function repoRoot(): string {
  return new URL(".", import.meta.url).pathname.replace(
    /worker\/deno\/tests\/$/,
    "",
  );
}

function readRepoFile(relPath: string): Promise<string> {
  return Deno.readTextFile(`${repoRoot()}${relPath}`);
}

/** The Rust CI pins under test: crate, fleet template id, and workflow copy. */
const PINS = [
  {
    crate: "cargo-audit",
    specId: "cargo-audit",
    workflow: ".github/workflows/cargo-audit.yml",
  },
  {
    crate: "cargo-edit",
    specId: "cargo-upgrade",
    workflow: ".github/workflows/cargo-upgrade.yml",
  },
] as const;

/** The exact pin shape every cargo install in this scope must use. */
const CARGO_INSTALL_PIN =
  /cargo install --locked (\S+) --version (\d+\.\d+\.\d+)/;

function parsePin(text: string): { crate: string; version: string } {
  const m = CARGO_INSTALL_PIN.exec(text);
  assert(
    m !== null,
    "no `cargo install --locked <crate> --version x.y.z` pin found",
  );
  const [, crate = "", version = ""] = m;
  return { crate, version };
}

function templateOf(id: string): string {
  const spec = WORKFLOW_SPECS.find((s) => s.id === id);
  assert(spec !== undefined, `no WORKFLOW_SPECS entry with id ${id}`);
  return spec.template;
}

interface WorkflowStep {
  name?: string;
  run?: string;
}
interface WorkflowJob {
  steps?: WorkflowStep[];
}
interface Workflow {
  jobs?: Record<string, WorkflowJob>;
}

/** Every `run:` step of every job in a workflow document, as written. */
function runSteps(text: string): string[] {
  const wf = parseYaml(text) as Workflow;
  const runs: string[] = [];
  for (const job of Object.values(wf.jobs ?? {})) {
    for (const step of job.steps ?? []) {
      if (typeof step.run === "string") runs.push(step.run);
    }
  }
  return runs;
}

// ---------------------------------------------------------------------------
// 1. Every run: step pins its cargo install (template and real workflow)
// ---------------------------------------------------------------------------

for (const pin of PINS) {
  Deno.test(
    `cargo install is pinned in the ${pin.specId} template and ${pin.workflow}`,
    async () => {
      const sources: Array<[string, string]> = [
        [`WORKFLOW_SPECS ${pin.specId} template`, templateOf(pin.specId)],
        [pin.workflow, await readRepoFile(pin.workflow)],
      ];
      for (const [label, text] of sources) {
        const runs = runSteps(text);
        // Positive control: the scan must see the cargo install at all, or
        // the empty-offenders assertion below could pass vacuously.
        assert(
          runs.some((run) => run.includes("cargo install")),
          `${label}: no run: step contains \`cargo install\``,
        );
        const offenders = runs.flatMap((run) =>
          findUnpinnedInstalls(run).map((hit) =>
            `${label}: ${hit.tool} → ${hit.spec}`
          )
        );
        assertEquals(
          offenders,
          [],
          "cargo install must pin an exact version with --locked (Issue #4683)",
        );
      }
    },
  );
}

// ---------------------------------------------------------------------------
// 2. Template and workflow copy agree on the crate version (lock-step)
// ---------------------------------------------------------------------------

for (const pin of PINS) {
  Deno.test(
    `${pin.specId} template and ${pin.workflow} install the same ${pin.crate} version`,
    async () => {
      const fromTemplate = parsePin(templateOf(pin.specId));
      const fromWorkflow = parsePin(await readRepoFile(pin.workflow));
      assertEquals(fromTemplate.crate, pin.crate);
      assertEquals(fromWorkflow.crate, pin.crate);
      assertEquals(fromTemplate.version, fromWorkflow.version);
    },
  );
}

// ---------------------------------------------------------------------------
// 3. Renovate's crate customManager keeps the pins current
// ---------------------------------------------------------------------------

interface CustomManager {
  customType?: string;
  managerFilePatterns?: string[];
  matchStrings?: string[];
  datasourceTemplate?: string;
}
interface RenovateConfig {
  customManagers?: CustomManager[];
}

Deno.test(
  "renovate crate customManager captures and matches the cargo install pins",
  async () => {
    const config = JSON.parse(
      await readRepoFile("renovate.json"),
    ) as RenovateConfig;
    const manager = (config.customManagers ?? []).find((m) =>
      m.datasourceTemplate === "crate"
    );
    assert(
      manager !== undefined,
      'renovate.json must declare a customManager with datasourceTemplate "crate"',
    );
    const pattern = manager.matchStrings?.[0];
    assert(
      pattern !== undefined,
      "crate customManager needs a matchStrings entry",
    );
    // The pattern is this repository's own committed renovate.json, which is
    // exactly what the test exists to exercise. There is no external input.
    // nosemgrep: javascript.lang.security.audit.detect-non-literal-regexp.detect-non-literal-regexp
    const re = new RegExp(pattern);

    for (const pin of PINS) {
      const text = await readRepoFile(pin.workflow);
      const m = re.exec(text);
      assert(m !== null, `crate customManager must match ${pin.workflow}`);
      assertEquals(m.groups?.depName, pin.crate);
      assertEquals(m.groups?.currentValue, parsePin(text).version);
    }

    // The manager must be scoped to the workflow file it is meant to bump.
    const scopesWorkflow = (manager.managerFilePatterns ?? []).some((p) => {
      const body = p.replace(/^\/|\/$/g, "");
      // nosemgrep: javascript.lang.security.audit.detect-non-literal-regexp.detect-non-literal-regexp
      return new RegExp(body).test(".github/workflows/cargo-audit.yml");
    });
    assert(
      scopesWorkflow,
      "crate customManager managerFilePatterns must match .github/workflows/cargo-audit.yml",
    );

    // Negative: unpinned or unlocked installs must not be captured.
    assertEquals(re.test("cargo install cargo-audit"), false);
    assertEquals(re.test("cargo install cargo-audit --version 0.22.2"), false);
  },
);
