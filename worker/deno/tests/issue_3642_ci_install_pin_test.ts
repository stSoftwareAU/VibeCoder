/**
 * Regression test for Issue #3642 — CI `run:` steps installed third-party
 * packages with no version pin, so they sat outside the repository's 24-hour
 * dependency quarantine.
 *
 * `.github/workflows/markdown-lint.yml` installed `markdownlint-cli2`,
 * `dependency-audit.yml` installed `bundler-audit`, and `pages.yml` installed
 * `pa11y-ci`/`http-server` and ran `npx --yes wait-on` — every one of them
 * resolving to whatever the registry served at run time. Renovate's
 * `minimumReleaseAge` only covers manifests it can manage, and this repo has
 * no npm manifest at all, so a hijacked release would have executed on the
 * runner with zero embargo.
 *
 * `action_pin_scanner.ts` only inspects `uses:` references, so a `run:`-level
 * install is invisible to it. This test closes that gap for this repository:
 * it parses the real workflow YAML and asserts every `run:`-level package
 * install pins an exact version.
 *
 * Australian English throughout (behaviour, organisation).
 */

import { assert, assertEquals } from "@std/assert";
import { parse as parseYaml } from "@std/yaml/parse";
// Issue #3668 promoted the detector this test used to define locally into
// `lib/ci_install_pin_scanner.ts`, where the github-actions-audit native
// pre-filer shares it. The repository invariant below now exercises the
// promoted implementation, so the two can never drift apart.
import { findUnpinnedInstalls } from "../lib/ci_install_pin_scanner.ts";

/** Resolve the repository root (three levels up from worker/deno/tests/). */
function repoRoot(): string {
  return new URL(".", import.meta.url).pathname.replace(
    /worker\/deno\/tests\/$/,
    "",
  );
}

// ---------------------------------------------------------------------------
// Unit tests — the detector itself
// ---------------------------------------------------------------------------

Deno.test("findUnpinnedInstalls flags an unpinned global npm install", () => {
  const found = findUnpinnedInstalls("npm install -g markdownlint-cli2");
  assertEquals(found.length, 1);
  assertEquals(found[0]?.spec, "markdownlint-cli2");
  assertEquals(found[0]?.tool, "npm");
});

Deno.test("findUnpinnedInstalls accepts an exact npm pin", () => {
  assertEquals(
    findUnpinnedInstalls(
      "npm install -g --ignore-scripts markdownlint-cli2@0.23.2",
    ),
    [],
  );
});

Deno.test("findUnpinnedInstalls flags a major-only npm range", () => {
  const found = findUnpinnedInstalls(
    "npm install -g pa11y-ci@3 http-server@14",
  );
  assertEquals(found.map((f) => f.spec), ["pa11y-ci@3", "http-server@14"]);
});

Deno.test("findUnpinnedInstalls flags caret and tilde npm ranges", () => {
  const found = findUnpinnedInstalls("npm install -g http-server@^14.1.1");
  assertEquals(found.length, 1);
});

Deno.test("findUnpinnedInstalls handles scoped packages", () => {
  assertEquals(findUnpinnedInstalls("npm install -g @scope/tool@1.0.0"), []);
  assertEquals(findUnpinnedInstalls("npm install -g @scope/tool").length, 1);
});

Deno.test("findUnpinnedInstalls flags an unpinned npx invocation", () => {
  const found = findUnpinnedInstalls("npx --yes wait-on http://localhost:8080");
  assertEquals(found.length, 1);
  assertEquals(found[0]?.spec, "wait-on");
});

Deno.test("findUnpinnedInstalls accepts a pinned npx invocation", () => {
  assertEquals(
    findUnpinnedInstalls("npx --yes wait-on@8.0.5 http://localhost:8080"),
    [],
  );
});

Deno.test("findUnpinnedInstalls flags an unpinned gem install", () => {
  const found = findUnpinnedInstalls("gem install bundler-audit");
  assertEquals(found.length, 1);
  assertEquals(found[0]?.tool, "gem");
});

Deno.test("findUnpinnedInstalls accepts gem install -v <exact>", () => {
  assertEquals(
    findUnpinnedInstalls("gem install --no-document bundler-audit -v 0.9.3"),
    [],
  );
});

Deno.test("findUnpinnedInstalls ignores non-install commands", () => {
  assertEquals(
    findUnpinnedInstalls(
      [
        "# npm install -g example",
        "npm ci --ignore-scripts",
        'npm config set prefix "$HOME/.npm-global"',
        "bundle-audit check --update",
        "",
      ].join("\n"),
    ),
    [],
  );
});

Deno.test("findUnpinnedInstalls inspects each chained command", () => {
  const found = findUnpinnedInstalls(
    "npm install -g tool-a@1.0.0 && npm install -g tool-b",
  );
  assertEquals(found.map((f) => f.spec), ["tool-b"]);
});

// ---------------------------------------------------------------------------
// Repository invariant — the real workflows
// ---------------------------------------------------------------------------

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

async function workflowFiles(): Promise<string[]> {
  const dir = `${repoRoot()}.github/workflows`;
  const paths: string[] = [];
  for await (const entry of Deno.readDir(dir)) {
    if (entry.isFile && /\.ya?ml$/.test(entry.name)) {
      paths.push(`${dir}/${entry.name}`);
    }
  }
  return paths.sort();
}

Deno.test("every workflow run: step pins the packages it installs", async () => {
  const files = await workflowFiles();
  assert(files.length > 0, "expected at least one workflow file");

  const offenders: string[] = [];
  for (const path of files) {
    const wf = parseYaml(await Deno.readTextFile(path)) as Workflow;
    for (const [jobName, job] of Object.entries(wf.jobs ?? {})) {
      for (const step of job.steps ?? []) {
        for (const hit of findUnpinnedInstalls(step.run ?? "")) {
          offenders.push(
            `${path.replace(repoRoot(), "")} [${jobName} / ` +
              `${step.name ?? "unnamed"}] ${hit.tool} → ${hit.spec}`,
          );
        }
      }
    }
  }

  assertEquals(
    offenders,
    [],
    "CI installs must pin an exact version so they stay inside the 24h " +
      "dependency quarantine (Issue #3642):\n" + offenders.join("\n"),
  );
});

// ---------------------------------------------------------------------------
// Repository invariant — Renovate keeps those pins current
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

/** Apply a Renovate custom manager's regexes and collect `depName@version`. */
function capturedDeps(manager: CustomManager, text: string): string[] {
  const deps: string[] = [];
  for (const pattern of manager.matchStrings ?? []) {
    for (const m of text.matchAll(new RegExp(pattern, "g"))) {
      const { depName, currentValue } = m.groups ?? {};
      if (depName && currentValue) deps.push(`${depName}@${currentValue}`);
    }
  }
  return deps;
}

Deno.test("renovate custom managers capture every pinned CI install", async () => {
  const config = JSON.parse(
    await Deno.readTextFile(`${repoRoot()}renovate.json`),
  ) as RenovateConfig;
  const managers = config.customManagers ?? [];
  assert(
    managers.length > 0,
    "renovate.json must declare customManagers for `run:`-level installs",
  );

  // Every manager must target the workflow tree and name a datasource, or
  // Renovate silently ignores it and the quarantine does not apply.
  for (const manager of managers) {
    assertEquals(manager.customType, "regex");
    assert(manager.datasourceTemplate, "manager must set datasourceTemplate");
    // The `run:`-install managers (npm / rubygems) must match the workflow
    // tree; the toolchain-pin managers (Issue #4403) match `.deno-version`
    // and `.node-version` at the repo root by design.
    if (["npm", "rubygems"].includes(manager.datasourceTemplate)) {
      assert(
        (manager.managerFilePatterns ?? []).some((p) =>
          p.includes(".github/workflows")
        ),
        "manager must match the workflow tree",
      );
    }
  }

  const captured = new Set<string>();
  for (const path of await workflowFiles()) {
    const text = await Deno.readTextFile(path);
    for (const manager of managers) {
      for (const dep of capturedDeps(manager, text)) captured.add(dep);
    }
  }

  for (
    const expected of [
      "markdownlint-cli2@0.23.2",
      "http-server@14.1.1",
      "pa11y-ci@3.1.0",
      "bundler-audit@0.9.3",
    ]
  ) {
    assert(
      captured.has(expected),
      `no renovate customManager captures ${expected}; captured: ` +
        `${[...captured].join(", ")}`,
    );
  }
});
