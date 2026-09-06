/**
 * Windows Task Scheduler registration for VibeCoder (Issue #4185).
 *
 * The twin of `setup/launchagent.ts`: launchd invokes `run.sh` every five
 * minutes on macOS, and Task Scheduler invokes `run.ps1` every five minutes
 * here, so a Windows host supervises itself the same way. Non-Windows hosts
 * skip gracefully.
 *
 * Three things differ from the plist, deliberately:
 *
 * 1. **No secrets in the definition.** The plist embeds `GH_TOKEN` and
 *    `ANTHROPIC_API_KEY` in plaintext (Issue #2514) and is written 0600 to
 *    contain the damage. Task XML has no environment-variable section at all,
 *    and none is wanted: the worker reads its credentials from the credential
 *    directory (Issue #4064), so this file leaks nothing.
 * 2. **UTF-16, not UTF-8.** `schtasks.exe /XML` rejects a UTF-8 definition, so
 *    the document is encoded UTF-16LE with a byte-order mark.
 * 3. **Registration is the check.** There is no "the file already matches, so
 *    the task must be registered" shortcut — `/F` replaces any existing task,
 *    and the exit status of `schtasks` is what decides the outcome, never the
 *    absence of a failure (Issue #3234).
 *
 * `LogonTrigger` + `InteractiveToken` is the closest analogue of the
 * LaunchAgent's `gui/<uid>` domain: the worker runs in the logged-on user's
 * interactive session, so it keeps the desktop access a headless service
 * would not have.
 *
 * Australian English spelling used throughout (behaviour, colour, etc.).
 */

import { escapeXml } from "../lib/xml_escape.ts";

/** The registered task name — the analogue of the LaunchAgent's label. */
export const SCHEDULED_TASK_NAME = "VibeCoderAutoIssueWorker";

/** How often the task fires when nothing says otherwise. */
const DEFAULT_INTERVAL_MINUTES = 5;

/** The PowerShell host used when the caller does not name one. */
const DEFAULT_POWERSHELL = "powershell.exe";

/** Configuration for the scheduled task. */
export interface ScheduledTaskConfig {
  /** Root directory of the VibeCoder checkout, in Windows spelling. */
  scriptDir: string;
  /** Task name to register. Defaults to {@link SCHEDULED_TASK_NAME}. */
  taskName?: string;
  /** Repetition interval in minutes. Defaults to 5. */
  intervalMinutes?: number;
  /** PowerShell executable the task runs. Defaults to `powershell.exe`. */
  powershell?: string;
  /** Principal the task runs as, e.g. `VIBE-PC\vibe`. Omitted when unset. */
  userId?: string;
  /** Where the definition is written. Defaults to `<scriptDir>\<task>.xml`. */
  taskXmlPath?: string;
  /** Host platform. Defaults to `Deno.build.os` — injectable for tests. */
  os?: string;
  /** Write the definition but register nothing (for testing). */
  skipSchtasks?: boolean;
  /** Runs `schtasks.exe`. Injectable so tests register nothing. */
  runSchtasks?: (
    args: readonly string[],
  ) => Promise<{ success: boolean; output: string }>;
}

/** Result of a scheduled-task operation. */
export interface ScheduledTaskResult {
  ok: boolean;
  message: string;
}

/** Strip trailing separators so `<dir>\run.ps1` never doubles up. */
function trimTrailingSeparators(dir: string): string {
  return dir.replace(/[\\/]+$/, "");
}

/**
 * Generate the Task Scheduler XML definition.
 *
 * @param config - Checkout location, cadence, PowerShell host and principal
 * @returns The task definition, ready to be encoded and registered
 */
export function generateScheduledTaskXml(config: ScheduledTaskConfig): string {
  const scriptDir = trimTrailingSeparators(config.scriptDir);
  const runScript = `${scriptDir}\\run.ps1`;
  const interval = config.intervalMinutes ?? DEFAULT_INTERVAL_MINUTES;
  const powershell = config.powershell ?? DEFAULT_POWERSHELL;
  const taskName = config.taskName ?? SCHEDULED_TASK_NAME;
  // The path is quoted inside the single Arguments string, so a checkout under
  // "C:\Program Files\…" reaches PowerShell as one argument.
  const argumentList =
    `-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "${runScript}"`;

  const principalUser = config.userId
    ? `      <UserId>${escapeXml(config.userId)}</UserId>\n`
    : "";

  return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.4" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <URI>\\${escapeXml(taskName)}</URI>
    <Description>Vibe Coder: runs run.ps1 every ${interval} minutes so the containerised worker keeps processing GitHub issues unattended.</Description>
  </RegistrationInfo>
  <Triggers>
    <LogonTrigger>
      <Enabled>true</Enabled>
      <Repetition>
        <Interval>PT${interval}M</Interval>
        <StopAtDurationEnd>false</StopAtDurationEnd>
      </Repetition>
    </LogonTrigger>
  </Triggers>
  <Principals>
    <Principal id="Author">
${principalUser}      <LogonType>InteractiveToken</LogonType>
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <AllowHardTerminate>true</AllowHardTerminate>
    <StartWhenAvailable>true</StartWhenAvailable>
    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>
    <IdleSettings>
      <StopOnIdleEnd>false</StopOnIdleEnd>
      <RestartOnIdle>false</RestartOnIdle>
    </IdleSettings>
    <Enabled>true</Enabled>
    <Hidden>false</Hidden>
    <RunOnlyIfIdle>false</RunOnlyIfIdle>
    <WakeToRun>false</WakeToRun>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <Priority>7</Priority>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>${escapeXml(powershell)}</Command>
      <Arguments>${escapeXml(argumentList)}</Arguments>
      <WorkingDirectory>${escapeXml(scriptDir)}</WorkingDirectory>
    </Exec>
  </Actions>
</Task>`;
}

/**
 * Encode a task definition as UTF-16LE with a byte-order mark.
 *
 * `schtasks.exe /XML` fails on a UTF-8 file, so this is not cosmetic.
 *
 * @param xml - The task definition
 * @returns The bytes to write, BOM first
 */
export function encodeTaskXmlUtf16(xml: string): Uint8Array {
  const bytes = new Uint8Array(2 + xml.length * 2);
  bytes[0] = 0xff;
  bytes[1] = 0xfe;
  const view = new DataView(bytes.buffer);
  for (let index = 0; index < xml.length; index += 1) {
    view.setUint16(2 + index * 2, xml.charCodeAt(index), true);
  }
  return bytes;
}

/**
 * Unregister the scheduled task (Issue #26) — the LaunchAgent removal's twin,
 * for the operator who answers "no" on a host where an earlier setup
 * registered it. Idempotent: a task that is not registered is not an error.
 *
 * @param config - Task name and the injectable schtasks driver
 * @returns Whether the task is gone, and what happened
 */
export async function removeScheduledTask(config: {
  taskName?: string;
  os?: string;
  skipSchtasks?: boolean;
  runSchtasks?: (
    args: readonly string[],
  ) => Promise<{ success: boolean; output: string }>;
}): Promise<ScheduledTaskResult> {
  const os = config.os ?? Deno.build.os;
  if (os !== "windows") {
    return {
      ok: true,
      message: "Scheduled task removal is only relevant on Windows — skipped",
    };
  }
  const taskName = config.taskName ?? SCHEDULED_TASK_NAME;
  if (config.skipSchtasks) {
    return { ok: true, message: `Would unregister task ${taskName}` };
  }
  const runSchtasks = config.runSchtasks ?? defaultRunSchtasks;
  const query = await runSchtasks(["/Query", "/TN", taskName]);
  if (!query.success) {
    return { ok: true, message: `No scheduled task ${taskName} is registered` };
  }
  const { success, output } = await runSchtasks([
    "/Delete",
    "/TN",
    taskName,
    "/F",
  ]);
  if (!success) {
    return {
      ok: false,
      message: `schtasks /Delete failed for ${taskName}: ${
        output.trim() || "no output"
      }`,
    };
  }
  return { ok: true, message: `Scheduled task ${taskName} unregistered` };
}

/**
 * Whether the scheduled task is registered (Issue #26) — what setup asks
 * before offering to remove it. Off Windows, or with no schtasks, false.
 */
export async function isScheduledTaskRegistered(config: {
  taskName?: string;
  os?: string;
  runSchtasks?: (
    args: readonly string[],
  ) => Promise<{ success: boolean; output: string }>;
} = {}): Promise<boolean> {
  const os = config.os ?? Deno.build.os;
  if (os !== "windows") return false;
  const runSchtasks = config.runSchtasks ?? defaultRunSchtasks;
  const query = await runSchtasks([
    "/Query",
    "/TN",
    config.taskName ?? SCHEDULED_TASK_NAME,
  ]);
  return query.success;
}

/** Run `schtasks.exe` and capture what it said. */
async function defaultRunSchtasks(
  args: readonly string[],
): Promise<{ success: boolean; output: string }> {
  try {
    const output = await new Deno.Command("schtasks.exe", {
      args: [...args],
      stdin: "null",
      stdout: "piped",
      stderr: "piped",
    }).output();
    const decoder = new TextDecoder();
    return {
      success: output.success,
      output: `${decoder.decode(output.stdout)}${decoder.decode(output.stderr)}`
        .trim(),
    };
  } catch (error) {
    // A schtasks that cannot even start is a failure, never a silent skip.
    return { success: false, output: (error as Error).message };
  }
}

/**
 * Register the Windows scheduled task (idempotent).
 *
 * On non-Windows platforms nothing is written and nothing is run.
 *
 * @param config - Checkout location plus the injectable schtasks driver
 * @returns Whether the task is registered, and what to do when it is not
 */
export async function setupScheduledTask(
  config: ScheduledTaskConfig,
): Promise<ScheduledTaskResult> {
  const os = config.os ?? Deno.build.os;
  if (os !== "windows") {
    return {
      ok: true,
      message: "Scheduled task setup is only available on Windows — skipped",
    };
  }

  const taskName = config.taskName ?? SCHEDULED_TASK_NAME;
  const xmlPath = config.taskXmlPath ??
    `${trimTrailingSeparators(config.scriptDir)}\\${taskName}.xml`;

  await Deno.writeFile(
    xmlPath,
    encodeTaskXmlUtf16(generateScheduledTaskXml(config)),
  );

  if (config.skipSchtasks) {
    return { ok: true, message: `Task definition written to ${xmlPath}` };
  }

  const args = ["/Create", "/TN", taskName, "/XML", xmlPath, "/F"];
  const runSchtasks = config.runSchtasks ?? defaultRunSchtasks;
  const { success, output } = await runSchtasks(args);
  if (!success) {
    return {
      ok: false,
      message: `Could not register the ${taskName} scheduled task: ` +
        `${output || "schtasks.exe exited non-zero"}. Register it by hand ` +
        `with: schtasks ${args.join(" ")}`,
    };
  }

  return {
    ok: true,
    message: `Scheduled task ${taskName} registered — run.ps1 every ` +
      `${config.intervalMinutes ?? DEFAULT_INTERVAL_MINUTES} minutes ` +
      `(definition: ${xmlPath})`,
  };
}
