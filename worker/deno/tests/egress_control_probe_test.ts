/**
 * Tests for the egress probe script and its validation (Issue #4051).
 *
 * The pure tests cover validation and parsing. The real-bash tests run
 * {@link EGRESS_PROBE_SCRIPT} under bash against real sockets.
 *
 * `deno task test:unit` grants no network permission, so every listener runs in
 * a child `deno eval` process granted `--allow-net=127.0.0.1` only. The probe
 * itself runs under bash, which is not subject to Deno's permissions. The real
 * bash tests are ignored, and their names say so, only when `bash` or `timeout`
 * is not on PATH. They are never silently passed.
 */

import {
  assert,
  assertEquals,
  assertStringIncludes,
  assertThrows,
} from "@std/assert";
import {
  buildProbeEnv,
  EGRESS_PROBE_SCRIPT,
  parseProbeOutput,
  PROBE_ENV,
  type ProbeSpec,
} from "../lib/egress_control_probe.ts";
import type { ProbeObservation } from "../lib/egress_controls.ts";

const NONCE = "0123456789abcdef";

/** A spec every validation test changes one field of. */
function legalSpec(): ProbeSpec {
  return {
    timeoutSeconds: 2,
    literals4: ["1.1.1.1:443"],
    literals6: ["[2606:4700:4700::1111]:443"],
    names: ["example.com:443"],
    dnsName: "example.com",
    hostAddresses: ["192.168.64.1"],
    hostPort: 8080,
    nonce: NONCE,
    proxy: {
      host: "127.0.0.1",
      port: 3128,
      allowedHost: "allowed.example",
      deniedHost: "denied.example",
    },
    tools: [{ name: "npm", url: "https://registry.npmjs.org/" }],
    gitUrl: "https://github.com/stSoftwareAU/VibeCoder.git",
  };
}

function withProxy(
  change: Partial<NonNullable<ProbeSpec["proxy"]>>,
): Partial<ProbeSpec> {
  return {
    proxy: {
      host: "127.0.0.1",
      port: 3128,
      allowedHost: "allowed.example",
      deniedHost: "denied.example",
      ...change,
    },
  };
}

// ----- buildProbeEnv -----

Deno.test("buildProbeEnv names every PROBE_ variable the script reads", () => {
  const env = buildProbeEnv(legalSpec());
  for (const name of Object.values(PROBE_ENV)) {
    assertStringIncludes(EGRESS_PROBE_SCRIPT, name);
    assertEquals(typeof env[name], "string", name);
  }
  assertEquals(env.PROBE_TIMEOUT, "2");
  assertEquals(env.PROBE_LITERALS4, "1.1.1.1:443");
  assertEquals(env.PROBE_HOST_PORT, "8080");
  assertEquals(env.PROBE_PROXY, "127.0.0.1:3128");
  assertEquals(env.PROBE_TOOLS, "npm=https://registry.npmjs.org/");
});

Deno.test("buildProbeEnv leaves unused variables empty rather than absent", () => {
  const env = buildProbeEnv({
    ...legalSpec(),
    literals4: [],
    literals6: [],
    names: [],
    hostAddresses: [],
    proxy: undefined,
    tools: [],
    gitUrl: undefined,
  });
  assertEquals(env.PROBE_PROXY, "");
  assertEquals(env.PROBE_ALLOW_HOST, "");
  assertEquals(env.PROBE_DENY_HOST, "");
  assertEquals(env.PROBE_TOOLS, "");
  assertEquals(env.PROBE_GIT_URL, "");
});

Deno.test("buildProbeEnv never lets whitespace, quotes, $ or backticks through", () => {
  const env = buildProbeEnv(legalSpec());
  for (const value of Object.values(env)) {
    assertEquals(/[\s'"`$]/.test(value.replaceAll(" ", "")), false, value);
  }
});

/** Each bad value must be refused with a message naming its field. */
const BAD_FIELD_CASES: Array<{
  field: string;
  bad: Array<Partial<ProbeSpec>>;
  legal: Partial<ProbeSpec>;
}> = [
  {
    field: "timeoutSeconds",
    bad: [{ timeoutSeconds: 0 }, { timeoutSeconds: 31 }, {
      timeoutSeconds: 1.5,
    }],
    legal: { timeoutSeconds: 5 },
  },
  {
    field: "literals4",
    bad: [
      { literals4: ["1.1.1.1"] },
      { literals4: ["1.1.1.300:443"] },
      { literals4: ["1.1.1.1:0"] },
      { literals4: ["::1:443"] },
    ],
    legal: { literals4: ["1.1.1.1:443"] },
  },
  {
    field: "literals6",
    bad: [
      { literals6: ["2606:4700::1111:443"] },
      { literals6: ["[zz::1]:443"] },
      { literals6: ["[2606:4700::1111]:99999"] },
    ],
    legal: { literals6: ["[2606:4700::1111]:443"] },
  },
  {
    field: "names",
    bad: [
      { names: ["bad host:443"] },
      { names: ["example.com"] },
      { names: ["-bad.example:443"] },
    ],
    legal: { names: ["example.com:443"] },
  },
  {
    field: "dnsName",
    bad: [{ dnsName: "bad name" }, { dnsName: "bad_name" }, {
      dnsName: "a..b",
    }],
    legal: { dnsName: "example.com" },
  },
  {
    field: "hostAddresses",
    bad: [
      { hostAddresses: ["not-an-ip"] },
      { hostAddresses: ["192.168.64.1:8080"] },
    ],
    legal: { hostAddresses: ["192.168.64.1"] },
  },
  {
    field: "hostPort",
    bad: [{ hostPort: 0 }, { hostPort: 70000 }, { hostPort: 80.5 }],
    legal: { hostPort: 8080 },
  },
  {
    field: "nonce",
    bad: [
      { nonce: "abc" },
      { nonce: "ABCDEF0123456789" },
      { nonce: "0123456789abcdef; rm" },
    ],
    legal: { nonce: "0123456789abcdef" },
  },
  {
    field: "proxy.host",
    bad: [withProxy({ host: "bad host" })],
    legal: withProxy({ host: "proxy.example" }),
  },
  {
    field: "proxy.port",
    bad: [withProxy({ port: 0 }), withProxy({ port: 65536 })],
    legal: withProxy({ port: 3128 }),
  },
  {
    field: "proxy.allowedHost",
    bad: [withProxy({ allowedHost: "allowed host" })],
    legal: withProxy({ allowedHost: "allowed.example" }),
  },
  {
    field: "proxy.deniedHost",
    bad: [withProxy({ deniedHost: "1.2.3.4$(id)" })],
    legal: withProxy({ deniedHost: "denied.example" }),
  },
  {
    field: "tools[0].name",
    bad: [{ tools: [{ name: "Bad Name", url: "https://x.example/" }] }],
    legal: { tools: [{ name: "npm", url: "https://x.example/" }] },
  },
  {
    field: "tools[0].url",
    bad: [
      { tools: [{ name: "npm", url: "http://x.example/" }] },
      { tools: [{ name: "npm", url: "https://1.2.3.4/" }] },
      { tools: [{ name: "npm", url: "https://user:pw@x.example/" }] },
      { tools: [{ name: "npm", url: "https://x.example/a'b" }] },
      { tools: [{ name: "npm", url: "https://[::1]/" }] },
    ],
    legal: { tools: [{ name: "npm", url: "https://x.example/a" }] },
  },
  {
    field: "gitUrl",
    bad: [{ gitUrl: "git@github.com:x/y.git" }, {
      gitUrl: "https://x.example/a b",
    }],
    legal: { gitUrl: "https://x.example/y.git" },
  },
];

for (const { field, bad, legal } of BAD_FIELD_CASES) {
  Deno.test(`buildProbeEnv refuses a bad ${field} and names it`, () => {
    for (const change of bad) {
      assertThrows(
        () => buildProbeEnv({ ...legalSpec(), ...change }),
        Error,
        field,
      );
    }
  });

  Deno.test(`buildProbeEnv accepts ${field} once it is made legal`, () => {
    const env = buildProbeEnv({ ...legalSpec(), ...legal });
    assert(typeof env.PROBE_NONCE === "string");
  });
}

// ----- parseProbeOutput -----

Deno.test("parseProbeOutput reads each observation kind in the documented grammar", () => {
  const text = [
    "net 192.168.64.2 192.168.64.1 no",
    "net none none yes",
    "tcp literal4 1.1.1.1:443 timeout",
    "tcp literal6 [2606:4700::1111]:443 unreachable",
    "tcp name4 example.com:443 refused",
    "tcp host 192.168.64.1:8080 ok",
    "dns example.com fail",
    "connect allowed.example 200 none",
    "connect denied.example 403 not-allowlisted",
    "tool npm ok http_200",
    "tool git fail could_not_resolve_host",
    "",
  ].join("\n");
  assertEquals(parseProbeOutput(text), [
    {
      kind: "net",
      address: "192.168.64.2",
      gateway: "192.168.64.1",
      ipv6: false,
    },
    { kind: "net", address: null, gateway: null, ipv6: true },
    {
      kind: "tcp",
      family: "literal4",
      target: "1.1.1.1:443",
      outcome: "timeout",
    },
    {
      kind: "tcp",
      family: "literal6",
      target: "[2606:4700::1111]:443",
      outcome: "unreachable",
    },
    {
      kind: "tcp",
      family: "name4",
      target: "example.com:443",
      outcome: "refused",
    },
    { kind: "tcp", family: "host", target: "192.168.64.1:8080", outcome: "ok" },
    { kind: "dns", name: "example.com", ok: false },
    { kind: "connect", host: "allowed.example", status: 200, reason: null },
    {
      kind: "connect",
      host: "denied.example",
      status: 403,
      reason: "not-allowlisted",
    },
    { kind: "tool", name: "npm", ok: true, detail: "http_200" },
    {
      kind: "tool",
      name: "git",
      ok: false,
      detail: "could_not_resolve_host",
    },
  ]);
});

Deno.test("parseProbeOutput accepts CRLF line endings", () => {
  assertEquals(parseProbeOutput("tcp host 1.1.1.1:9 ok\r\n"), [
    { kind: "tcp", family: "host", target: "1.1.1.1:9", outcome: "ok" },
  ]);
});

Deno.test("parseProbeOutput ignores blank lines and lines without a known kind", () => {
  const text = "\nbash: line 3: whatever\nnetwork is down\nnetaaaa\n\n";
  assertEquals(parseProbeOutput(text), []);
});

Deno.test("parseProbeOutput throws on a known kind with a malformed line", () => {
  const malformed = [
    "net 1.1.1.1",
    "net 1.1.1.1 none yes extra",
    "tcp literal4 1.1.1.1:443 maybe",
    "tcp weird 1.1.1.1:443 ok",
    "dns example.com maybe",
    "connect allowed.example 40 none",
    "connect allowed.example 200 Bad_Reason",
    "tool npm maybe x",
  ];
  for (const line of malformed) {
    assertThrows(() => parseProbeOutput(line), Error, "malformed", line);
  }
});

Deno.test("parseProbeOutput refuses hostile over-long lines for every known kind", () => {
  for (const kind of ["net", "tcp", "dns", "connect", "tool"]) {
    const line = `${kind} ${"a".repeat(100_000)}`;
    assertThrows(() => parseProbeOutput(line), Error, "malformed", kind);
  }
});

Deno.test("parseProbeOutput stays linear on long single-character runs per pattern", () => {
  const started = performance.now();
  const hostile = [
    `net ${"1".repeat(1000)}`,
    `tcp ${"a".repeat(1000)} ok`,
    `tcp literal4 ${"a".repeat(1000)}`,
    `dns ${"a".repeat(1000)} ok`,
    `connect ${"a".repeat(1000)} 200 none`,
    `connect a.example ${"2".repeat(1000)} none`,
    `connect a.example 200 ${"a".repeat(1000)}`,
    `tool ${"a".repeat(1000)} ok x`,
    `tool npm ok ${"a".repeat(1000)}`,
  ];
  for (const line of hostile) {
    assertThrows(
      () => parseProbeOutput(line),
      Error,
      "malformed",
      line.slice(0, 12),
    );
  }
  assert(performance.now() - started < 1000, "hostile input took too long");
});

Deno.test("EGRESS_PROBE_SCRIPT never evaluates a value as code", () => {
  assertEquals(/\beval\b/.test(EGRESS_PROBE_SCRIPT), false);
});

// ----- real bash, under Deno's permissions -----

const FIXTURE_DEADLINE_MS = 8_000;

/** Whether an executable is on PATH, checked without spawning anything. */
function onPath(name: string): boolean {
  const dirs = (Deno.env.get("PATH") ?? "").split(":").filter((dir) =>
    dir !== ""
  );
  return dirs.some((dir) => {
    try {
      return Deno.statSync(`${dir}/${name}`).isFile;
    } catch {
      return false;
    }
  });
}

const BASH_READY = onPath("bash") && onPath("timeout");
if (!BASH_READY) {
  console.log(
    "egress_control_probe_test: bash or timeout is not on PATH; the real-bash probe tests are ignored",
  );
}

/** A real-bash test, ignored by name and flag when bash or timeout is missing. */
function realBashTest(name: string, fn: () => Promise<void>): void {
  Deno.test({
    name: BASH_READY ? name : `${name} (ignored: bash or timeout not on PATH)`,
    ignore: !BASH_READY,
    fn,
  });
}

type FixtureMode = "nonce" | "closed" | "connect";

/**
 * The child process a fixture runs. It listens on 127.0.0.1 only, reports its
 * port, then does one job and exits: `nonce` reads the nonce a host probe
 * writes, `closed` listens and closes, `connect` answers two CONNECTs.
 */
function fixtureCode(mode: FixtureMode): string {
  return `
(async () => {
  const mode = ${JSON.stringify(mode)};
  const allowed = "allowed.example";
  const encoder = new TextEncoder();
  const timer = setTimeout(() => Deno.exit(0), ${FIXTURE_DEADLINE_MS});
  const listener = Deno.listen({ hostname: "127.0.0.1", port: 0 });
  console.log("PORT " + listener.addr.port);
  const readUntil = async (conn, marker) => {
    const decoder = new TextDecoder();
    const buffer = new Uint8Array(512);
    let text = "";
    while (!text.includes(marker)) {
      const count = await conn.read(buffer);
      if (count === null) break;
      text += decoder.decode(buffer.subarray(0, count), { stream: true });
    }
    return text;
  };
  if (mode === "closed") {
    listener.close();
  } else if (mode === "nonce") {
    const conn = await listener.accept();
    const text = await readUntil(conn, "\\n");
    console.log("NONCE " + text.split("\\n")[0]);
    conn.close();
    listener.close();
  } else {
    for (let served = 0; served < 2; served++) {
      const conn = await listener.accept();
      const head = await readUntil(conn, "\\r\\n\\r\\n");
      const host = head.split(" ")[1].split(":")[0];
      const body = "[EGRESS_DENIED] host=" + host + " reason=not-allowlisted\\n";
      const reply = host === allowed
        ? "HTTP/1.1 200 Connection Established\\r\\n\\r\\n"
        : "HTTP/1.1 403 Forbidden\\r\\nContent-Type: text/plain\\r\\nConnection: close\\r\\nContent-Length: " +
          body.length + "\\r\\n\\r\\n" + body;
      await conn.write(encoder.encode(reply));
      conn.close();
    }
    listener.close();
  }
  clearTimeout(timer);
})();
`;
}

interface Fixture {
  /** The port the fixture is listening on. */
  readonly port: number;
  /** Wait for the fixture to finish and return what it printed after its port. */
  finish(): Promise<string[]>;
  /** Stop the fixture if it is still running, and release its pipes. */
  close(): Promise<void>;
}

async function startFixture(mode: FixtureMode): Promise<Fixture> {
  const child = new Deno.Command(Deno.execPath(), {
    args: ["eval", "--allow-net=127.0.0.1", fixtureCode(mode)],
    stdin: "null",
    stdout: "piped",
    stderr: "piped",
  }).spawn();
  const reader = child.stdout.pipeThrough(new TextDecoderStream()).getReader();
  let pending = "";
  const nextLine = async (): Promise<string | null> => {
    while (!pending.includes("\n")) {
      const { value, done } = await reader.read();
      if (done) {
        if (pending === "") return null;
        const rest = pending;
        pending = "";
        return rest;
      }
      pending += value;
    }
    const newline = pending.indexOf("\n");
    const line = pending.slice(0, newline);
    pending = pending.slice(newline + 1);
    return line;
  };

  let settling: Promise<void> | undefined;
  const settle = (kill: boolean): Promise<void> => {
    settling ??= (async () => {
      if (kill) {
        try {
          child.kill("SIGKILL");
        } catch {
          // The fixture has already exited.
        }
      }
      await reader.cancel().catch(() => {});
      await child.status;
      await new Response(child.stderr).text();
    })();
    return settling;
  };

  const first = await nextLine();
  const match = /^PORT (\d{1,5})$/.exec(first ?? "");
  if (match === null) {
    await settle(true);
    throw new Error(`fixture did not report a port: ${JSON.stringify(first)}`);
  }
  const [, portText = "0"] = match;
  return {
    port: Number(portText),
    async finish() {
      const lines: string[] = [];
      for (
        let line = await nextLine();
        line !== null;
        line = await nextLine()
      ) {
        lines.push(line);
      }
      await settle(false);
      return lines;
    },
    close: () => settle(true),
  };
}

interface ProbeOutcome {
  code: number;
  stdout: string;
  stderr: string;
  observations: ProbeObservation[];
}

/** Run the real script under bash with the spec's environment. */
async function runProbe(spec: ProbeSpec): Promise<ProbeOutcome> {
  const output = await new Deno.Command("bash", {
    args: ["-c", EGRESS_PROBE_SCRIPT],
    env: buildProbeEnv(spec),
    stdin: "null",
    stdout: "piped",
    stderr: "piped",
  }).output();
  const stdout = new TextDecoder().decode(output.stdout);
  return {
    code: output.code,
    stdout,
    stderr: new TextDecoder().decode(output.stderr),
    observations: parseProbeOutput(stdout),
  };
}

function baseSpec(overrides: Partial<ProbeSpec> = {}): ProbeSpec {
  return {
    timeoutSeconds: 2,
    literals4: [],
    literals6: [],
    names: [],
    dnsName: "localhost",
    hostAddresses: [],
    hostPort: 9,
    nonce: NONCE,
    tools: [],
    ...overrides,
  };
}

/** The outcome of every tcp observation, in print order. */
function tcpOutcomes(observations: ProbeObservation[]): string[] {
  return observations.flatMap((observation) =>
    observation.kind === "tcp" ? [observation.outcome] : []
  );
}

realBashTest(
  "probe reports an open host listener as ok and the listener receives the nonce",
  async () => {
    const fixture = await startFixture("nonce");
    try {
      const outcome = await runProbe(
        baseSpec({ hostAddresses: ["127.0.0.1"], hostPort: fixture.port }),
      );
      assertEquals(outcome.code, 0, outcome.stderr);
      assertEquals(
        outcome.observations.filter((observation) =>
          observation.kind === "tcp" && observation.family === "host" &&
          observation.target === `127.0.0.1:${fixture.port}` &&
          observation.outcome === "ok"
        ).length,
        1,
        outcome.stdout,
      );
      assert(
        outcome.observations.some((observation) => observation.kind === "net"),
        outcome.stdout,
      );
      assertEquals(await fixture.finish(), [`NONCE ${NONCE}`]);
    } finally {
      await fixture.close();
    }
  },
);

realBashTest(
  "a closed port is refused on the literal and host paths, never ok",
  async () => {
    const fixture = await startFixture("closed");
    try {
      const outcome = await runProbe(
        baseSpec({
          literals4: [`127.0.0.1:${fixture.port}`],
          hostAddresses: ["127.0.0.1"],
          hostPort: fixture.port,
        }),
      );
      assertEquals(outcome.code, 0, outcome.stderr);
      assertEquals(
        tcpOutcomes(outcome.observations),
        ["refused", "refused"],
        outcome.stdout,
      );
    } finally {
      await fixture.close();
    }
  },
);

realBashTest(
  "TEST-NET 192.0.2.1 times out or is unreachable, never ok or refused",
  async () => {
    const outcome = await runProbe(
      baseSpec({ timeoutSeconds: 1, literals4: ["192.0.2.1:443"] }),
    );
    assertEquals(outcome.code, 0, outcome.stderr);
    const outcomes = tcpOutcomes(outcome.observations);
    assertEquals(outcomes.length, 1, outcome.stdout);
    assert(
      outcomes[0] === "timeout" || outcomes[0] === "unreachable",
      `TEST-NET attempt was ${outcomes[0]}`,
    );
  },
);

realBashTest(
  "dns resolves localhost and fails for nonexistent.invalid",
  async () => {
    const local = await runProbe(baseSpec({ dnsName: "localhost" }));
    assertEquals(local.code, 0, local.stderr);
    assertEquals(
      local.observations.filter((observation) => observation.kind === "dns"),
      [{ kind: "dns", name: "localhost", ok: true }],
    );

    const missing = await runProbe(
      baseSpec({ dnsName: "nonexistent.invalid" }),
    );
    assertEquals(missing.code, 0, missing.stderr);
    assertEquals(
      missing.observations.filter((observation) => observation.kind === "dns"),
      [{ kind: "dns", name: "nonexistent.invalid", ok: false }],
    );
  },
);

realBashTest(
  "CONNECT exchange: allowed host answers 200, denied host answers 403 not-allowlisted",
  async () => {
    const fixture = await startFixture("connect");
    try {
      const outcome = await runProbe(
        baseSpec({
          proxy: {
            host: "127.0.0.1",
            port: fixture.port,
            allowedHost: "allowed.example",
            deniedHost: "denied.example",
          },
        }),
      );
      assertEquals(outcome.code, 0, outcome.stderr);
      assertEquals(
        outcome.observations.filter((observation) =>
          observation.kind === "connect"
        ),
        [
          {
            kind: "connect",
            host: "allowed.example",
            status: 200,
            reason: null,
          },
          {
            kind: "connect",
            host: "denied.example",
            status: 403,
            reason: "not-allowlisted",
          },
        ],
        outcome.stdout,
      );
      await fixture.finish();
    } finally {
      await fixture.close();
    }
  },
);
