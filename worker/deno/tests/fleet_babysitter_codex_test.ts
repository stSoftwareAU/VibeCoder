import { assert, assertEquals, assertRejects } from "@std/assert";
import {
  type CodexInstallDeps,
  ensureBabysitterCodex,
} from "../lib/fleet_babysitter_codex.ts";
import { parseContainerManifest } from "../lib/container_manifest.ts";
import {
  BABYSITTER_CODEX_FLOOR,
  codexVersionMeetsFloor,
  readCodexVersion,
} from "../lib/fleet_babysitter_sandbox.ts";

const TARGET = "aarch64-apple-darwin";
const VERSION = "0.164.0";

async function sha256Hex(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

/** A release archive holding one executable script named `<name>-<target>`. */
async function archive(
  name: string,
  script: string,
): Promise<Uint8Array<ArrayBuffer>> {
  const dir = await Deno.makeTempDir();
  try {
    await Deno.writeTextFile(`${dir}/${name}-${TARGET}`, script);
    const out = await new Deno.Command("tar", {
      args: ["-czf", `${dir}/a.tar.gz`, "-C", dir, `${name}-${TARGET}`],
    }).output();
    assert(out.success);
    return await Deno.readFile(`${dir}/a.tar.gz`);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

/** A fake release, its manifest and deps reporting `pathVersion` for PATH. */
async function fixture(
  pathVersion: string | undefined,
  options: { corruptCli?: boolean; os?: string } = {},
) {
  const root = await Deno.makeTempDir();
  const cli = await archive(
    "codex",
    `#!/bin/sh\necho "codex-cli ${VERSION}"\n`,
  );
  const host = await archive("codex-code-mode-host", "#!/bin/sh\n");
  const manifest = JSON.parse(
    await Deno.readTextFile(
      new URL("../../../container/tools.json", import.meta.url),
    ),
  );
  const codex = manifest.providers.find((p: { id: string }) =>
    p.id === "codex"
  );
  codex.version = VERSION;
  codex.hostSha256 = {
    "darwin-arm64": options.corruptCli ? "0".repeat(64) : await sha256Hex(cli),
  };
  codex.codeModeHost.hostSha256 = { "darwin-arm64": await sha256Hex(host) };
  const manifestPath = `${root}/tools.json`;
  await Deno.writeTextFile(manifestPath, JSON.stringify(manifest));
  const fetched: string[] = [];
  const base =
    `https://github.com/openai/codex/releases/download/rust-v${VERSION}`;
  const deps: CodexInstallDeps = {
    readVersion: (binary) =>
      binary === "codex"
        ? pathVersion === undefined
          ? Promise.reject(new Deno.errors.NotFound("codex"))
          : Promise.resolve(pathVersion)
        : readCodexVersion(binary),
    fetchFn: (input) => {
      const url = String(input);
      fetched.push(url);
      const body = url === `${base}/codex-${TARGET}.tar.gz`
        ? cli
        : url === `${base}/codex-code-mode-host-${TARGET}.tar.gz`
        ? host
        : undefined;
      return Promise.resolve(
        body ? new Response(body) : new Response("", { status: 404 }),
      );
    },
    manifestPath,
    os: options.os ?? "darwin",
    arch: "aarch64",
  };
  const home = `${root}/home`;
  await Deno.mkdir(home);
  return {
    deps,
    fetched,
    home,
    dir: `${home}/.vibe-coder/codex/${VERSION}-${TARGET}`,
    cleanup: () => Deno.remove(root, { recursive: true }),
  };
}

Deno.test("babysitter uses codex from PATH when it meets the floor", async () => {
  const f = await fixture("codex-cli 0.166.0-alpha.5.1");
  try {
    assertEquals(await ensureBabysitterCodex(f.home, f.deps), "codex");
    assertEquals(f.fetched, []);
  } finally {
    await f.cleanup();
  }
});

for (
  const [label, pathVersion] of [
    ["too old", "codex-cli 0.110.0"],
    ["missing", undefined],
  ] as const
) {
  Deno.test(`babysitter installs the pinned Codex when PATH codex is ${label}, then reuses it`, async () => {
    const f = await fixture(pathVersion);
    try {
      const codex = await ensureBabysitterCodex(f.home, f.deps);
      assertEquals(codex, `${f.dir}/codex`);
      assertEquals(await readCodexVersion(codex), `codex-cli ${VERSION}`);
      const host = await Deno.stat(`${f.dir}/codex-code-mode-host`);
      assert(host.isFile && (host.mode! & 0o111) !== 0);
      assertEquals(f.fetched.length, 2);
      assertEquals(
        [...Deno.readDirSync(`${f.home}/.vibe-coder/codex`)].map((e) => e.name),
        [`${VERSION}-${TARGET}`],
      );

      assertEquals(await ensureBabysitterCodex(f.home, f.deps), codex);
      assertEquals(f.fetched.length, 2);
    } finally {
      await f.cleanup();
    }
  });
}

Deno.test("babysitter refuses a Codex archive that does not match its pin", async () => {
  const f = await fixture("codex-cli 0.110.0", { corruptCli: true });
  try {
    await assertRejects(
      () => ensureBabysitterCodex(f.home, f.deps),
      Error,
      "Checksum mismatch",
    );
    assertEquals(
      [...Deno.readDirSync(`${f.home}/.vibe-coder/codex`)].length,
      0,
    );
  } finally {
    await f.cleanup();
  }
});

Deno.test("babysitter names the platform it cannot install Codex on", async () => {
  const f = await fixture(undefined, { os: "windows" });
  try {
    await assertRejects(
      () => ensureBabysitterCodex(f.home, f.deps),
      Error,
      "windows/aarch64",
    );
  } finally {
    await f.cleanup();
  }
});

Deno.test("the pinned Codex meets the babysitter floor and is pinned for both macOS architectures", async () => {
  const manifest = parseContainerManifest(
    await Deno.readTextFile(
      new URL("../../../container/tools.json", import.meta.url),
    ),
  );
  const codex = manifest.providers.find((p) => p.id === "codex")!;
  assert(
    codexVersionMeetsFloor(`codex-cli ${codex.version}`),
    `pinned ${codex.version} is below ${BABYSITTER_CODEX_FLOOR}`,
  );
  for (const key of ["darwin-amd64", "darwin-arm64"]) {
    assert(codex.hostSha256?.[key], `codex.hostSha256.${key}`);
    assert(
      codex.codeModeHost?.hostSha256?.[key],
      `codex.codeModeHost.hostSha256.${key}`,
    );
  }
});
