/** The hosted Podman diagnostic must preserve failures and the rootless claim. */
import { assertEquals, assertStringIncludes } from "@std/assert";
import { parse } from "@std/yaml/parse";

type Obj = Record<string, unknown>;
function record(value: unknown): Obj {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Obj
    : {};
}
function job(workflow: unknown): Obj {
  return record(record(record(workflow).jobs)["podman-prerequisite"]);
}
function steps(workflow: unknown): Obj[] {
  const entries = job(workflow).steps;
  return Array.isArray(entries) ? entries.map(record) : [];
}
function step(workflow: unknown, id: string): Obj {
  return steps(workflow).find((entry) => entry.id === id) ?? {};
}
function problems(workflow: unknown): string[] {
  const result: string[] = [];
  const check = (ok: boolean, reason: string) => {
    if (!ok) result.push(reason);
  };
  const target = job(workflow);
  check(target["runs-on"] === "ubuntu-24.04", "pinned Ubuntu release");
  check(record(target.env).PODMAN_VERSION === "4.9.3", "pinned Podman version");
  check(
    target["continue-on-error"] !== true && target.if === undefined,
    "job failures propagate",
  );
  for (const id of ["prerequisite", "build", "handlers", "separate"]) {
    const entry = step(workflow, id);
    const run = String(entry.run ?? "");
    check(
      run.trimStart().startsWith("set -euo pipefail"),
      `${id} preserves shell failures`,
    );
    check(
      entry.if === undefined && entry["continue-on-error"] !== true &&
        !run.includes("|| true"),
      `${id} failures propagate`,
    );
    check(
      !/\bsudo\b|\bsysctl\b|--privileged|seccomp=unconfined|apparmor=unconfined/
        .test(run),
      `${id} keeps host and security profiles`,
    );
  }
  const prerequisite = String(step(workflow, "prerequisite").run);
  check(
    prerequisite.includes(
      'test "$(podman --version)" = "podman version ${PODMAN_VERSION}"',
    ),
    "checks actual runtime version",
  );
  check(
    prerequisite.includes(
      "test \"$(podman info --format '{{.Host.Security.Rootless}}')\" = true",
    ),
    "checks actual rootless info",
  );
  check(
    prerequisite.includes(
      "podman info --format json | tee -a /tmp/agent-podman-info.log",
    ),
    "retains runtime info",
  );
  const build = String(step(workflow, "build").run);
  check(
    build.includes("strip-containerfile --out /tmp/Containerfile.stripped") &&
      build.includes(
        'podman build -f /tmp/Containerfile.stripped -t "${IMAGE}" container/',
      ),
    "builds production image with Podman",
  );
  const handlers = String(step(workflow, "handlers").run);
  check(
    handlers.includes("tests/agent_container_probe_test.ts") &&
      handlers.includes("tests/agent_container_probe_workflow_test.ts") &&
      handlers.includes("tests/anthropic_agent_gateway_test.ts"),
    "runs probe and workflow assertions",
  );
  const separate = String(step(workflow, "separate").run);
  check(
    separate.includes(
      'tests/fixtures/agent_container_probe_cli.ts "${IMAGE}" podman',
    ),
    "selects Podman probe explicitly",
  );
  check(
    separate.includes("2>&1 | tee /tmp/agent-podman-container-probe.log"),
    "retains probe output",
  );
  for (const id of ["handlers", "separate"]) {
    check(
      step(workflow, id)["working-directory"] === "worker/deno",
      `${id} resolves frozen lock`,
    );
    check(
      String(step(workflow, id).run).includes("--frozen --lock=deno.lock"),
      `${id} uses frozen lock`,
    );
  }
  const checkout = steps(workflow).find((entry) =>
    String(entry.uses).startsWith("actions/checkout@")
  );
  check(
    record(checkout?.with)["persist-credentials"] === false,
    "checkout retains no credentials",
  );
  const artifact = steps(workflow).find((entry) =>
    String(entry.uses).startsWith("actions/upload-artifact@")
  );
  check(artifact?.if === "always()", "artifacts survive failure");
  check(
    String(record(artifact?.with).path).includes(
      "/tmp/agent-podman-info.log",
    ) &&
      String(record(artifact?.with).path).includes(
        "/tmp/agent-podman-container-probe.log",
      ),
    "uploads both evidence logs",
  );
  return result;
}
async function workflow(): Promise<unknown> {
  return parse(
    await Deno.readTextFile(
      new URL(
        "../../../.github/workflows/agent-namespace-probe.yml",
        import.meta.url,
      ),
    ),
  );
}
Deno.test("Podman validation workflow preserves the declared rootless proof boundary", async () => {
  assertEquals(problems(await workflow()), []);
});
Deno.test("Podman workflow validator detects each weakened prerequisite and evidence contract", async () => {
  const original = await workflow();
  const mutateRun =
    (id: string, from: string, to: string) => (value: unknown) => {
      const entry = step(value, id);
      entry.run = String(entry.run).replace(from, to);
    };
  const cases: Array<[string, (value: unknown) => void]> = [
    ["pinned Ubuntu release", (w) => job(w)["runs-on"] = "ubuntu-latest"],
    [
      "pinned Podman version",
      (w) => record(job(w).env).PODMAN_VERSION = "latest",
    ],
    ["job failures propagate", (w) => job(w)["continue-on-error"] = true],
    ["job failures propagate", (w) => job(w).if = false],
    [
      "checks actual runtime version",
      mutateRun(
        "prerequisite",
        'test "$(podman --version)',
        'echo "$(podman --version)',
      ),
    ],
    [
      "checks actual rootless info",
      mutateRun("prerequisite", " = true", " = false"),
    ],
    ["retains runtime info", mutateRun("prerequisite", "tee -a", "cat -a")],
    [
      "builds production image with Podman",
      mutateRun("build", "podman build", "docker build"),
    ],
    [
      "builds production image with Podman",
      mutateRun(
        "build",
        "strip-containerfile --out",
        "different-command --out",
      ),
    ],
    [
      "runs probe and workflow assertions",
      mutateRun(
        "handlers",
        "tests/agent_container_probe_test.ts",
        "tests/other.ts",
      ),
    ],
    [
      "runs probe and workflow assertions",
      mutateRun(
        "handlers",
        "tests/agent_container_probe_workflow_test.ts",
        "tests/other.ts",
      ),
    ],
    [
      "runs probe and workflow assertions",
      mutateRun(
        "handlers",
        "tests/anthropic_agent_gateway_test.ts",
        "tests/other.ts",
      ),
    ],
    [
      "selects Podman probe explicitly",
      mutateRun("separate", '"${IMAGE}" podman', '"${IMAGE}" docker'),
    ],
    ["retains probe output", mutateRun("separate", "2>&1 | tee", "2>&1 | cat")],
    [
      "checkout retains no credentials",
      (w) =>
        record(
          steps(w).find((s) => String(s.uses).startsWith("actions/checkout@"))
            ?.with,
        )["persist-credentials"] = true,
    ],
    ["artifacts survive failure", (w) => {
      const s = steps(w).find((s) =>
        String(s.uses).startsWith("actions/upload-artifact@")
      )!;
      s.if = "success()";
    }],
    ["uploads both evidence logs", (w) => {
      const s = steps(w).find((s) =>
        String(s.uses).startsWith("actions/upload-artifact@")
      )!;
      record(s.with).path = "/tmp/other.log";
    }],
  ];
  for (const id of ["prerequisite", "build", "handlers", "separate"]) {
    cases.push(
      [
        `${id} preserves shell failures`,
        mutateRun(id, "set -euo pipefail", "set -eu"),
      ],
      [
        `${id} failures propagate`,
        (w) => step(w, id)["continue-on-error"] = true,
      ],
      [`${id} failures propagate`, (w) => step(w, id).if = false],
      [`${id} failures propagate`, (w) => step(w, id).run += "\nfalse || true"],
      [
        `${id} keeps host and security profiles`,
        (w) => step(w, id).run += "\nsudo podman info",
      ],
    );
  }
  for (const id of ["handlers", "separate"]) {
    cases.push(
      [
        `${id} resolves frozen lock`,
        (w) => step(w, id)["working-directory"] = ".",
      ],
      [`${id} uses frozen lock`, mutateRun(id, "--frozen", "")],
    );
  }
  for (const [reason, mutate] of cases) {
    const changed = structuredClone(original);
    mutate(changed);
    assertStringIncludes(problems(changed).join("\n"), reason);
  }
});
