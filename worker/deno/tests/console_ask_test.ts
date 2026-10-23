/**
 * `askOnConsole` asks so the question is seen under `setup.ps1` (Issue #4119).
 *
 * `setup.ps1` pipes the setup CLI's stdout through `Out-Host`, which prints a
 * line only once it ends. These tests drive `askOnConsole` with a recording
 * console and assert what it printed and asked, for a terminal and for a pipe.
 *
 * Australian English spelling throughout (behaviour, colour, etc.).
 */

import { assertEquals } from "@std/assert";
import {
  askOnConsole,
  CONSOLE_ASK_IO,
  type ConsoleAskIo,
} from "../setup/console_ask.ts";
import { createDefaultCopilotReviewDeps } from "../setup/copilot_review_setup.ts";
import { createDefaultUpdateModeDeps } from "../setup/update_mode_setup.ts";

/** A console that records each prompt and logged line, answering `answer`. */
function recordingConsole(
  stdoutIsTerminal: boolean,
  answer: string | null,
): { io: ConsoleAskIo; prompts: string[]; lines: string[] } {
  const prompts: string[] = [];
  const lines: string[] = [];
  return {
    io: {
      stdoutIsTerminal: () => stdoutIsTerminal,
      prompt: (message) => {
        prompts.push(message);
        return answer;
      },
      log: (message) => lines.push(message),
    },
    prompts,
    lines,
  };
}

const QUESTION = "Update mode — dynamic or frozen? [dynamic]";

Deno.test("askOnConsole - a pipe gets the question as a whole line, then a bare > prompt", async () => {
  const c = recordingConsole(false, "frozen");

  const answer = await askOnConsole(QUESTION, c.io);

  assertEquals(answer, "frozen");
  // Out-Host prints a line only once it ends, so the question must end first.
  assertEquals(c.lines, [QUESTION]);
  assertEquals(c.prompts, [">"]);
});

Deno.test("askOnConsole - a terminal is asked the question in place", async () => {
  const c = recordingConsole(true, "dynamic");

  const answer = await askOnConsole(QUESTION, c.io);

  assertEquals(answer, "dynamic");
  assertEquals(c.lines, []);
  assertEquals(c.prompts, [QUESTION]);
});

Deno.test("askOnConsole - EOF is null, not a guessed answer", async () => {
  const c = recordingConsole(false, null);

  assertEquals(await askOnConsole(QUESTION, c.io), null);
});

Deno.test("askOnConsole - update-mode's real deps ask through it", async () => {
  const c = recordingConsole(false, "frozen");

  const answer = await createDefaultUpdateModeDeps(c.io).ask(QUESTION);

  // A bare prompt() would leave the question unterminated under Out-Host.
  assertEquals(answer, "frozen");
  assertEquals(c.lines, [QUESTION]);
  assertEquals(c.prompts, [">"]);
});

Deno.test("askOnConsole - copilot-review-mode's real deps ask through it", async () => {
  const c = recordingConsole(false, "leave");

  const answer = await createDefaultCopilotReviewDeps(c.io).ask(QUESTION);

  assertEquals(answer, "leave");
  assertEquals(c.lines, [QUESTION]);
  assertEquals(c.prompts, [">"]);
});

Deno.test("CONSOLE_ASK_IO - is the real stdout check, prompt() and console.log", () => {
  const originalIsTerminal = Deno.stdout.isTerminal;
  const originalPrompt = globalThis.prompt;
  const originalLog = console.log;
  const asked: (string | undefined)[] = [];
  const printed: string[] = [];
  Deno.stdout.isTerminal = () => true;
  globalThis.prompt = (message?: string) => {
    asked.push(message);
    return "typed";
  };
  console.log = (message?: unknown) => {
    printed.push(String(message));
  };
  try {
    assertEquals(CONSOLE_ASK_IO.stdoutIsTerminal(), true);
    assertEquals(CONSOLE_ASK_IO.prompt("Q?"), "typed");
    CONSOLE_ASK_IO.log("a line");
    Deno.stdout.isTerminal = () => false;
    assertEquals(CONSOLE_ASK_IO.stdoutIsTerminal(), false);
  } finally {
    Deno.stdout.isTerminal = originalIsTerminal;
    globalThis.prompt = originalPrompt;
    console.log = originalLog;
  }

  assertEquals(asked, ["Q?"]);
  assertEquals(printed, ["a line"]);
});
