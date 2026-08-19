/**
 * Tests for the Windows scheduled task (Issue #4185).
 *
 * The Task Scheduler entry is the Windows twin of the macOS LaunchAgent: it
 * invokes `run.ps1` every five minutes so a Windows host supervises itself.
 *
 * Every case calls the real functions. `schtasks.exe` is injected, so the suite
 * registers nothing and runs identically on macOS and Linux.
 *
 * Australian English spelling used throughout (behaviour, colour, etc.).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  encodeTaskXmlUtf16,
  generateScheduledTaskXml,
  SCHEDULED_TASK_NAME,
  setupScheduledTask,
} from "../setup/scheduled_task.ts";

/** A recorded `schtasks.exe` invocation. */
interface Recorded {
  args: string[][];
}

/** An injected schtasks that records its argv and reports success. */
function recordingSchtasks(recorded: Recorded, success = true, output = "") {
  return (args: readonly string[]) => {
    recorded.args.push([...args]);
    return Promise.resolve({ success, output });
  };
}

// ── XML generation ──────────────────────────────────────────────────────

Deno.test("generateScheduledTaskXml - runs run.ps1 from the checkout every 5 minutes", () => {
  const xml = generateScheduledTaskXml({
    scriptDir: "C:\\Users\\vibe\\VibeCoder",
  });

  assert(xml.startsWith("<?xml"), xml.slice(0, 40));
  assertStringIncludes(xml, "C:\\Users\\vibe\\VibeCoder\\run.ps1");
  assertStringIncludes(xml, "<Interval>PT5M</Interval>");
  assertStringIncludes(xml, "powershell.exe");
  assertStringIncludes(xml, "-NoProfile");
  assertStringIncludes(xml, "-ExecutionPolicy Bypass");
  assert(xml.trimEnd().endsWith("</Task>"), xml.slice(-40));
});

Deno.test("generateScheduledTaskXml - honours a custom interval and PowerShell host", () => {
  const xml = generateScheduledTaskXml({
    scriptDir: "C:\\VibeCoder",
    intervalMinutes: 10,
    powershell: "C:\\Program Files\\PowerShell\\7\\pwsh.exe",
  });

  assertStringIncludes(xml, "<Interval>PT10M</Interval>");
  assertStringIncludes(
    xml,
    "<Command>C:\\Program Files\\PowerShell\\7\\pwsh.exe</Command>",
  );
});

Deno.test("generateScheduledTaskXml - a second launch never stacks on the first", () => {
  // The five-minute cadence is shorter than a long worker run, so the policy
  // that stops two workers running at once is the whole reason the interval
  // is safe.
  const xml = generateScheduledTaskXml({ scriptDir: "C:\\VibeCoder" });
  assertStringIncludes(
    xml,
    "<MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>",
  );
  assertStringIncludes(xml, "<StartWhenAvailable>true</StartWhenAvailable>");
});

Deno.test("generateScheduledTaskXml - escapes XML metacharacters in every value", () => {
  const xml = generateScheduledTaskXml({
    scriptDir: 'C:\\Odd & "Path"<>',
    userId: "DOMAIN\\a&b",
  });

  // The raw ampersand must never survive into the document.
  assert(
    !/&(?!(amp|lt|gt|quot|apos);)/.test(xml),
    `unescaped ampersand in: ${xml}`,
  );
  assertStringIncludes(xml, "Odd &amp; &quot;Path&quot;&lt;&gt;");
  assertStringIncludes(xml, "DOMAIN\\a&amp;b");
});

Deno.test("generateScheduledTaskXml - carries no credential material at all", () => {
  // Unlike the macOS plist (Issue #2514), the task definition embeds no
  // secrets: the worker reads its credentials from the credential directory
  // (Issue #4064), so a world-readable task XML leaks nothing.
  const xml = generateScheduledTaskXml({ scriptDir: "C:\\VibeCoder" });
  for (
    const forbidden of [
      "GH_TOKEN",
      "OAUTH_TOKEN",
      "API_KEY",
      "EnvironmentVariables",
      "sk-ant",
      "gho_",
    ]
  ) {
    assert(
      !xml.toUpperCase().includes(forbidden.toUpperCase()),
      `the task XML must not mention ${forbidden}`,
    );
  }
});

Deno.test("generateScheduledTaskXml - omits the principal user when none is known", () => {
  const xml = generateScheduledTaskXml({ scriptDir: "C:\\VibeCoder" });
  assert(!xml.includes("<UserId>"), "an empty UserId must not be emitted");

  const withUser = generateScheduledTaskXml({
    scriptDir: "C:\\VibeCoder",
    userId: "VIBE-PC\\vibe",
  });
  assertStringIncludes(withUser, "<UserId>VIBE-PC\\vibe</UserId>");
});

// ── UTF-16 encoding (schtasks refuses anything else) ────────────────────

Deno.test("encodeTaskXmlUtf16 - writes a byte-order mark and UTF-16LE code units", () => {
  const bytes = encodeTaskXmlUtf16("<Task>ü</Task>");

  assertEquals([bytes[0], bytes[1]], [0xff, 0xfe], "missing UTF-16LE BOM");
  assertEquals(
    new TextDecoder("utf-16le").decode(bytes.slice(2)),
    "<Task>ü</Task>",
  );
});

// ── Registration ────────────────────────────────────────────────────────

Deno.test("setupScheduledTask - registers the generated XML with schtasks", async () => {
  const tmp = await Deno.makeTempDir();
  try {
    const recorded: Recorded = { args: [] };
    const xmlPath = `${tmp}/task.xml`;

    const result = await setupScheduledTask({
      scriptDir: "C:\\VibeCoder",
      os: "windows",
      taskXmlPath: xmlPath,
      runSchtasks: recordingSchtasks(recorded),
    });

    assertEquals(result.ok, true, result.message);
    assertEquals(recorded.args, [[
      "/Create",
      "/TN",
      SCHEDULED_TASK_NAME,
      "/XML",
      xmlPath,
      "/F",
    ]]);

    // The file schtasks was pointed at holds the generated definition, in the
    // UTF-16 encoding schtasks insists on.
    const bytes = await Deno.readFile(xmlPath);
    assertEquals([bytes[0], bytes[1]], [0xff, 0xfe]);
    const xml = new TextDecoder("utf-16le").decode(bytes.slice(2));
    assertEquals(
      xml,
      generateScheduledTaskXml({ scriptDir: "C:\\VibeCoder" }),
    );
  } finally {
    await Deno.remove(tmp, { recursive: true });
  }
});

Deno.test("setupScheduledTask - a schtasks failure is reported, never masked", async () => {
  const tmp = await Deno.makeTempDir();
  try {
    const recorded: Recorded = { args: [] };
    const result = await setupScheduledTask({
      scriptDir: "C:\\VibeCoder",
      os: "windows",
      taskXmlPath: `${tmp}/task.xml`,
      runSchtasks: recordingSchtasks(
        recorded,
        false,
        "ERROR: Access is denied.",
      ),
    });

    assertEquals(result.ok, false);
    assertStringIncludes(result.message, "Access is denied");
    // The operator is told how to finish by hand rather than left guessing.
    assertStringIncludes(result.message, "schtasks");
  } finally {
    await Deno.remove(tmp, { recursive: true });
  }
});

Deno.test("setupScheduledTask - re-registering the same task is idempotent", async () => {
  const tmp = await Deno.makeTempDir();
  try {
    const recorded: Recorded = { args: [] };
    const config = {
      scriptDir: "C:\\VibeCoder",
      os: "windows",
      taskXmlPath: `${tmp}/task.xml`,
      runSchtasks: recordingSchtasks(recorded),
    };

    assertEquals((await setupScheduledTask(config)).ok, true);
    assertEquals((await setupScheduledTask(config)).ok, true);

    // `/F` is what makes the second registration a replacement rather than a
    // duplicate task or an error.
    assertEquals(recorded.args.length, 2);
    for (const args of recorded.args) assert(args.includes("/F"));
  } finally {
    await Deno.remove(tmp, { recursive: true });
  }
});

Deno.test("setupScheduledTask - skips on every non-Windows host", async () => {
  for (const os of ["darwin", "linux"]) {
    const recorded: Recorded = { args: [] };
    const result = await setupScheduledTask({
      scriptDir: "/home/vibe/VibeCoder",
      os,
      runSchtasks: recordingSchtasks(recorded),
    });

    assertEquals(result.ok, true, `${os}: a skip is not a failure`);
    assertStringIncludes(result.message, "Windows");
    assertEquals(recorded.args, [], `${os} must not run schtasks`);
  }
});

Deno.test("setupScheduledTask - skipSchtasks writes the XML but registers nothing", async () => {
  const tmp = await Deno.makeTempDir();
  try {
    const recorded: Recorded = { args: [] };
    const xmlPath = `${tmp}/task.xml`;
    const result = await setupScheduledTask({
      scriptDir: "C:\\VibeCoder",
      os: "windows",
      taskXmlPath: xmlPath,
      skipSchtasks: true,
      runSchtasks: recordingSchtasks(recorded),
    });

    assertEquals(result.ok, true, result.message);
    assertEquals(recorded.args, []);
    assert((await Deno.stat(xmlPath)).isFile);
  } finally {
    await Deno.remove(tmp, { recursive: true });
  }
});
