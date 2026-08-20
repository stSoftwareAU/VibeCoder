/**
 * Tests for the worked Java + Maven `container_tools` example and the operator
 * documentation around it (Issue #75, closing slice of parent #5).
 *
 * The example in `docs/CONTAINER.md` is what a deployer copies into
 * `.config.json`, so it is checked the way a deployment would meet it rather
 * than by reading the prose: the fenced block is extracted, handed to the real
 * validator (`parseContainerTools`, the trust boundary from #69), and then —
 * with its URLs swapped for local fixture archives of the same shape, so the
 * suite stays offline and fast — driven through the real installer
 * (`container/install-tools.sh`, #70) to prove the documented
 * `stripComponents` / `bin` / `env` really produce `java` on PATH and
 * `JAVA_HOME` pointing at the install prefix.
 *
 * The remaining assertions cover the documentation surfaces this slice owes:
 * the `container_tools` row in the configuration table, the rebuild note in
 * the deployment guide, and the checksum-drift note — the #14 constraint
 * stated where a deployer reads it.
 *
 * Australian English spelling throughout (behaviour, organisation).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  CONTAINER_TOOL_PREFIX_ROOT,
  containerToolPrefix,
  parseContainerTools,
} from "../lib/container_tools_config.ts";
import type { ContainerToolSpec } from "../types.ts";

const REPO_ROOT = new URL("../../../", import.meta.url).pathname.replace(
  /\/$/,
  "",
);

/** The script the Containerfile runs for the deployer-selected tool set. */
const INSTALLER = `${REPO_ROOT}/container/install-tools.sh`;

function read(relative: string): string {
  return Deno.readTextFileSync(`${REPO_ROOT}/${relative}`);
}

/**
 * The fenced ```json blocks of a document, in order.
 */
function jsonBlocks(markdown: string): string[] {
  const blocks: string[] = [];
  const pattern = /```json\n([\s\S]*?)```/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(markdown)) !== null) blocks.push(match[1] ?? "");
  return blocks;
}

/** The documented worked example, as the raw `container_tools` array. */
function documentedExample(): unknown[] {
  const block = jsonBlocks(read("docs/CONTAINER.md")).find((body) =>
    body.includes('"container_tools"')
  );
  assert(
    block !== undefined,
    "docs/CONTAINER.md must carry a fenced json block declaring container_tools",
  );
  const parsed = JSON.parse(block) as Record<string, unknown>;
  const tools = parsed["container_tools"];
  assert(Array.isArray(tools), "the example must be a container_tools array");
  return tools;
}

/** The documented example, validated through the real parser. */
function validatedExample(): ContainerToolSpec[] {
  const result = parseContainerTools(documentedExample());
  assert(
    result.ok,
    `the documented example must pass validation: ${
      result.ok ? "" : result.error
    }`,
  );
  return result.value;
}

/** One validated entry of the example, by id. */
function exampleTool(id: string): ContainerToolSpec {
  const tool = validatedExample().find((entry) => entry.id === id);
  assert(tool !== undefined, `the worked example must declare "${id}"`);
  return tool;
}

// ---------------------------------------------------------------------------
// The example itself
// ---------------------------------------------------------------------------

Deno.test("container_tools example - the documented spec passes the real validator", () => {
  const tools = validatedExample();
  assertEquals(
    tools.map((tool) => tool.id),
    ["java", "maven"],
    "the worked example is the Java + Maven pair that motivated #5",
  );
});

Deno.test("container_tools example - Java pins both architectures, Maven is noarch", () => {
  const java = exampleTool("java");
  const maven = exampleTool("maven");

  for (const arch of ["amd64", "arm64"] as const) {
    assert(java.url[arch], `java must supply a ${arch} download`);
    assertEquals(
      java.sha256[arch]?.length,
      64,
      `java must pin a ${arch} SHA-256`,
    );
  }

  assert(maven.url.noarch, "maven ships one architecture-independent archive");
  assertEquals(maven.sha256.noarch?.length, 64, "maven must pin its SHA-256");
});

Deno.test("container_tools example - every download is https and an installable archive", () => {
  // The extensions container/install-tools.sh knows how to extract; an
  // unsupported one aborts the build rather than guessing.
  const supported = [".tar.gz", ".tgz", ".tar.xz", ".zip"];

  for (const tool of validatedExample()) {
    for (const [arch, url] of Object.entries(tool.url)) {
      assert(
        url.startsWith("https://"),
        `${tool.id}.${arch} must be fetched over https, got ${url}`,
      );
      assert(
        supported.some((extension) => url.endsWith(extension)),
        `${tool.id}.${arch} must end in a supported archive extension ` +
          `(${supported.join(", ")}), got ${url}`,
      );
    }
  }
});

Deno.test("container_tools example - bin and env stay inside the fixed prefix", () => {
  const java = exampleTool("java");
  const maven = exampleTool("maven");

  assertEquals(java.bin, ["bin"]);
  assertEquals(java.env["JAVA_HOME"], "", "JAVA_HOME is the prefix root");
  assertEquals(maven.bin, ["bin"]);
  assertEquals(
    containerToolPrefix(java.id),
    `${CONTAINER_TOOL_PREFIX_ROOT}/java`,
  );
});

// ---------------------------------------------------------------------------
// The example driven through the real installer, offline
// ---------------------------------------------------------------------------

/** Hex SHA-256 of a file. */
async function sha256Hex(path: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    await Deno.readFile(path),
  );
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * A `.tar.gz` shaped like the real distribution: one top-level directory
 * (which `stripComponents: 1` removes) holding `bin/<command>`.
 */
async function fixtureArchive(
  workDir: string,
  top: string,
  command: string,
): Promise<{ url: string; sha256: string }> {
  const binDir = `${workDir}/src-${top}/${top}/bin`;
  await Deno.mkdir(binDir, { recursive: true });
  await Deno.writeTextFile(`${binDir}/${command}`, "#!/bin/sh\necho fixture\n");
  const archive = `${workDir}/${top}.tar.gz`;
  const tar = await new Deno.Command("tar", {
    args: ["-czf", archive, "-C", `${workDir}/src-${top}`, top],
    stdout: "null",
    stderr: "piped",
  }).output();
  assert(tar.success, `tar failed: ${new TextDecoder().decode(tar.stderr)}`);
  return { url: `file://${archive}`, sha256: await sha256Hex(archive) };
}

/**
 * The documented example with every download replaced by a local fixture of
 * the same layout — the shape under test is the documented one, the bytes are
 * local so the suite needs no network.
 */
async function exampleWithFixtures(workDir: string): Promise<unknown[]> {
  const commands: Record<string, string> = { java: "java", maven: "mvn" };
  const spec = documentedExample() as Record<string, unknown>[];

  for (const entry of spec) {
    const id = entry.id as string;
    const command = commands[id] ?? id;
    const fixture = await fixtureArchive(workDir, `${id}-dist`, command);
    const url = entry.url as Record<string, string>;
    const sha256 = entry.sha256 as Record<string, string>;
    for (const arch of Object.keys(url)) {
      url[arch] = fixture.url;
      sha256[arch] = fixture.sha256;
    }
  }
  return spec;
}

async function runInstaller(
  spec: unknown,
  options: { prefix: string; workDir: string; arch: string },
): Promise<{ code: number; stdout: string; stderr: string }> {
  const specPath = `${options.workDir}/spec-${options.arch}.json`;
  await Deno.writeTextFile(specPath, JSON.stringify(spec));
  const result = await new Deno.Command("bash", {
    args: [INSTALLER, specPath],
    env: {
      VIBE_TOOLS_PREFIX: options.prefix,
      VIBE_BUILD_ARCH: options.arch,
    },
    stdout: "piped",
    stderr: "piped",
    stdin: "null",
  }).output();
  return {
    code: result.code,
    stdout: new TextDecoder().decode(result.stdout),
    stderr: new TextDecoder().decode(result.stderr),
  };
}

for (const arch of ["amd64", "arm64"]) {
  Deno.test(
    `container_tools example - installs java and maven on ${arch}`,
    async () => {
      const workDir = await Deno.makeTempDir({ prefix: "vibe-example-work-" });
      const prefix = await Deno.makeTempDir({ prefix: "vibe-example-prefix-" });
      try {
        const run = await runInstaller(await exampleWithFixtures(workDir), {
          prefix,
          workDir,
          arch,
        });
        assertEquals(
          run.code,
          0,
          `the documented example must install cleanly: ${run.stderr}`,
        );

        // stripComponents: 1 drops the distribution's top-level directory.
        assertEquals(
          (await Deno.stat(`${prefix}/java/bin/java`)).isFile,
          true,
        );
        assertEquals((await Deno.stat(`${prefix}/maven/bin/mvn`)).isFile, true);

        // The hand-off the entrypoint (#74) applies at container start.
        const environment = await Deno.readTextFile(`${prefix}/environment`);
        for (const line of [
          `PATH=${prefix}/java/bin`,
          `JAVA_HOME=${prefix}/java`,
          `PATH=${prefix}/maven/bin`,
          `MAVEN_HOME=${prefix}/maven`,
        ]) {
          assertStringIncludes(environment, line);
        }
      } finally {
        await Deno.remove(workDir, { recursive: true });
        await Deno.remove(prefix, { recursive: true });
      }
    },
  );
}

// ---------------------------------------------------------------------------
// The documentation surfaces this slice owes
// ---------------------------------------------------------------------------

Deno.test("container_tools docs - the configuration table carries the key", () => {
  const configuration = read("docs/CONFIGURATION.md");
  const row = configuration
    .split("\n")
    .find((line) => line.startsWith("| `container_tools`"));
  assert(
    row !== undefined,
    "docs/CONFIGURATION.md must document container_tools in the defaults table",
  );
  assertStringIncludes(row, CONTAINER_TOOL_PREFIX_ROOT);
});

Deno.test("container_tools docs - the container guide states the prefix and the mandatory digest", () => {
  const container = read("docs/CONTAINER.md");
  assertStringIncludes(container, "## Deployer-supplied build-time tools");
  assertStringIncludes(container, `${CONTAINER_TOOL_PREFIX_ROOT}/<id>`);
  assertStringIncludes(container, "sha256");
});

Deno.test("container_tools docs - checksum drift is answered with a config update, not relaxed verification", () => {
  const container = read("docs/CONTAINER.md");
  const drift = container.slice(
    container.indexOf("### When a checksum stops matching"),
  );
  assert(
    drift.startsWith("### When a checksum stops matching"),
    "docs/CONTAINER.md must answer checksum drift for a deployer",
  );
  const note = drift.slice(0, drift.indexOf("\n## "));
  assertStringIncludes(note, ".config.json");
  assertStringIncludes(note, "never");
});

Deno.test("container_tools docs - the deployment guide warns that the selection forces a rebuild", () => {
  const deployment = read("docs/DEPLOYMENT.md");
  assertStringIncludes(deployment, "container_tools");
  const section = deployment.slice(deployment.indexOf("container_tools"));
  assertStringIncludes(section, "rebuild");
});

Deno.test("container_tools docs - the changelog records the slice", () => {
  const changelog = read("CHANGELOG.md");
  const unreleased = changelog.slice(
    changelog.indexOf("## [Unreleased]"),
    changelog.indexOf("\n## [", changelog.indexOf("## [Unreleased]") + 1),
  );
  assertStringIncludes(unreleased, "container_tools");
});
