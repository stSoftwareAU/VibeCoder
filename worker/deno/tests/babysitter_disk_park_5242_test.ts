/**
 * Issue #5242: a host-disk admission refusal (Issue #5105) is a resource wait,
 * not a fault. The Chromium self-check is skipped for the pass, a refused
 * repair is parked like a spent quota (Issue #5072), and neither fails the
 * pass. A genuine error still does.
 */

import {
  assertEquals,
  assertInstanceOf,
  assertRejects,
  assertStringIncludes,
} from "@std/assert";
import {
  babysitterChromiumSelfCheck,
  runRepairs,
  startBabysitterFailure,
} from "../commands/fleet_pr_babysitter.ts";
import {
  BabysitterDiskPark,
  babysitterHostDiskAdmission,
} from "../lib/fleet_babysitter_container.ts";
import {
  BabysitterFailure,
  BabysitterParked,
} from "../lib/babysitter_retry_state.ts";

const GIB = 1024 ** 3;
const REFUSAL =
  "host disk has 65.8 GB free with 0.0 GB outstanding across 0 live reservation(s); the 17.2 GB request would breach the 49.4 GB floor (Issue #5105)";

function captureConsole<T>(body: () => Promise<T>) {
  const lines: { level: string; text: string }[] = [];
  const saved = { error: console.error, log: console.log, warn: console.warn };
  for (const level of ["error", "log", "warn"] as const) {
    console[level] = (...args: unknown[]) =>
      lines.push({ level, text: args.map(String).join(" ") });
  }
  return body().finally(() => Object.assign(console, saved)).then(
    (value) => ({ value, lines }),
  );
}

Deno.test("a refused host-disk admission raises a BabysitterDiskPark", async () => {
  const dir = await Deno.makeTempDir();
  try {
    for (const clone of [undefined, dir]) {
      const error = await assertRejects(() =>
        babysitterHostDiskAdmission(
          {
            containerName: "vibe-babysitter-5242",
            timeoutMs: 60_000,
            ...(clone === undefined ? {} : { clone }),
          },
          {
            measure: () =>
              Promise.resolve({
                availableBytes: 60 * GIB,
                totalBytes: 460 * GIB,
                usedBytes: 400 * GIB,
              }),
            floor: () => Promise.resolve(50 * GIB),
            reservationDir: () => Promise.resolve(dir),
            holdsCargo: () => Promise.resolve(false),
            log: () => {},
          },
        )
      );
      assertInstanceOf(error, BabysitterDiskPark);
      assertStringIncludes((error as Error).message, "not started");
    }
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("a disk-refused Chromium self-check is skipped quietly and the pass continues", async () => {
  const steps: string[] = [];
  const { value, lines } = await captureConsole(async () => {
    const ran = await babysitterChromiumSelfCheck(() =>
      Promise.reject(
        new BabysitterDiskPark(
          `babysitter Chromium check not started: ${REFUSAL}`,
        ),
      )
    );
    steps.push("pass");
    return ran;
  });
  assertEquals(value, false);
  assertEquals(steps, ["pass"]);
  assertEquals(lines.filter((line) => line.level === "error"), []);
  assertEquals(lines.length, 1);
  assertStringIncludes(lines[0]!.text, "skipped");
  assertStringIncludes(lines[0]!.text, "49.4 GB floor");
});

Deno.test("an admitted Chromium self-check reports that it ran", async () => {
  assertEquals(
    await babysitterChromiumSelfCheck(() => Promise.resolve()),
    true,
  );
});

Deno.test("a genuine Chromium self-check failure still fails the pass", async () => {
  await assertRejects(
    () =>
      babysitterChromiumSelfCheck(() =>
        Promise.reject(new Error("Chromium did not launch"))
      ),
    Error,
    "Chromium did not launch",
  );
});

Deno.test("a disk-refused repair is parked and not counted as a pass failure", async () => {
  const parked = startBabysitterFailure(
    new BabysitterDiskPark(`babysitter repair not started: ${REFUSAL}`),
  );
  assertInstanceOf(parked, BabysitterParked);
  const { lines } = await captureConsole(() =>
    runRepairs([{
      key: "repo#1",
      version: "head",
      run: () => Promise.reject(parked),
    }], 1)
  );
  assertEquals(lines.filter((line) => line.level === "error"), []);
  assertEquals(lines.length, 1);
  assertStringIncludes(lines[0]!.text, "parked");
});

Deno.test("a genuine repair failure still fails the pass", async () => {
  const failure = startBabysitterFailure(new Error("container exited 1"));
  assertEquals(failure instanceof BabysitterParked, false);
  await captureConsole(() =>
    assertRejects(
      () =>
        runRepairs([{
          key: "repo#1",
          version: "head",
          run: () => Promise.reject(failure),
        }], 1),
      AggregateError,
    )
  );
  assertInstanceOf(failure, BabysitterFailure);
});
