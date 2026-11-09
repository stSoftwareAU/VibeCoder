/** A process observation used while waiting for a spawned process to settle. */
export interface ProcessObservation {
  command: string | undefined;
  parentPid: number | undefined;
}

export interface WaitForOrphanOptions {
  observe: () => Promise<ProcessObservation | undefined>;
  sleep: (milliseconds: number) => Promise<void>;
  expectedCommand: string;
  maxAttempts?: number;
  intervalMs?: number;
}

/**
 * Wait a bounded time for a captured PID to have its final command and become
 * an orphan adopted by PID 1. The injected observation and sleep keep tests
 * deterministic; timeout errors include the last observed process state.
 */
export async function waitForSettledOrphan(
  pid: number,
  options: WaitForOrphanOptions,
): Promise<void> {
  const maxAttempts = options.maxAttempts ?? 50;
  const intervalMs = options.intervalMs ?? 100;
  let lastObservation: ProcessObservation | undefined;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    lastObservation = await options.observe();
    if (
      lastObservation?.command === options.expectedCommand &&
      lastObservation.parentPid === 1
    ) {
      return;
    }
    if (attempt + 1 < maxAttempts) await options.sleep(intervalMs);
  }

  throw new Error(
    `orphan ${pid} did not settle after ${maxAttempts} observations; ` +
      `last observed state=${JSON.stringify(lastObservation ?? null)}`,
  );
}
