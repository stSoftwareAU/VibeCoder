/**
 * The Copilot code review setup conversation (Issue #2701).
 *
 * Every test drives the real command with a scripted operator and asserts on
 * what landed in a temporary `.config.json` — no terminal, no network.
 *
 * Australian English spelling throughout (behaviour, colour, etc.).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  readCopilotCodeReviewSetting,
  writeCopilotCodeReviewConfig,
} from "../setup/config_writer.ts";
import {
  type CopilotReviewSetupDeps,
  runCopilotReviewSetup,
} from "../setup/copilot_review_setup.ts";
import { createConsoleStyler } from "../lib/console_style.ts";

interface Harness {
  deps: Partial<CopilotReviewSetupDeps>;
  asked: string[];
  said: string[];
}

/** A scripted operator; running out of answers is EOF. */
function harness(answers: string[], interactive = true): Harness {
  const asked: string[] = [];
  const said: string[] = [];
  const queue = [...answers];
  return {
    asked,
    said,
    deps: {
      ask: (question) => {
        asked.push(question);
        return Promise.resolve(queue.length > 0 ? queue.shift()! : null);
      },
      say: (message) => said.push(message),
      style: createConsoleStyler({ tty: false }),
      interactive: () => interactive,
    },
  };
}

/** A temp `.config.json` holding `content` (or none when `null`). */
async function withConfig(
  content: Record<string, unknown> | null,
  fn: (configPath: string) => Promise<void>,
): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "vibe-copilot-setup-" });
  const configPath = `${dir}/.config.json`;
  if (content !== null) {
    await Deno.writeTextFile(configPath, JSON.stringify(content, null, 2));
  }
  try {
    await fn(configPath);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

async function readJson(path: string): Promise<Record<string, unknown>> {
  return JSON.parse(await Deno.readTextFile(path));
}

Deno.test("copilot review setup - a fresh host defaults to leave, and Enter writes nothing (Issue #2701)", async () => {
  await withConfig({ repos: ["org/repo"] }, async (configPath) => {
    const before = await Deno.readTextFile(configPath);
    const h = harness([""]);
    const result = await runCopilotReviewSetup({ configPath, deps: h.deps });
    assert(result.ok);
    assertEquals(result.value, {
      mode: "leave",
      changed: false,
      prompted: true,
    });
    assertEquals(h.asked.length, 1);
    assertStringIncludes(h.asked[0]!, "[leave]");
    assertEquals(await Deno.readTextFile(configPath), before);
  });
});

Deno.test("copilot review setup - the question says plainly that each review is billed, even on public repositories (Issue #2701)", async () => {
  await withConfig({}, async (configPath) => {
    const h = harness([""]);
    await runCopilotReviewSetup({ configPath, deps: h.deps });
    const text = h.said.join("\n");
    assertStringIncludes(text, "billed");
    assertStringIncludes(text, "public");
    assertStringIncludes(text, "organisation");
    assertStringIncludes(h.asked[0]!, "on/off/leave");
  });
});

Deno.test("copilot review setup - answering off records it, keeping every other key (Issue #2701)", async () => {
  await withConfig(
    { repos: ["org/repo"], update_mode: "dynamic" },
    async (configPath) => {
      const h = harness(["OFF"]);
      const result = await runCopilotReviewSetup({ configPath, deps: h.deps });
      assert(result.ok);
      assertEquals(result.value, {
        mode: "off",
        changed: true,
        prompted: true,
      });
      assertEquals(await readJson(configPath), {
        repos: ["org/repo"],
        update_mode: "dynamic",
        copilot_code_review: "off",
      });
    },
  );
});

Deno.test("copilot review setup - a re-run defaults to the host's current value (Issue #2701)", async () => {
  await withConfig({ copilot_code_review: "on" }, async (configPath) => {
    const h = harness([""]);
    const result = await runCopilotReviewSetup({ configPath, deps: h.deps });
    assert(result.ok);
    assertEquals(result.value, { mode: "on", changed: false, prompted: true });
    assertStringIncludes(h.asked[0]!, "[on]");
  });
});

Deno.test("copilot review setup - an unknown answer is asked again (Issue #2701)", async () => {
  await withConfig({}, async (configPath) => {
    const h = harness(["maybe", "on"]);
    const result = await runCopilotReviewSetup({ configPath, deps: h.deps });
    assert(result.ok);
    assertEquals(result.value.mode, "on");
    assertEquals(h.asked.length, 2);
    assert(h.said.some((line) => line.includes('"maybe"')));
    assertEquals((await readJson(configPath)).copilot_code_review, "on");
  });
});

Deno.test("copilot review setup - input ending before an answer writes nothing and fails loud (Issue #2701)", async () => {
  await withConfig({ repos: ["org/repo"] }, async (configPath) => {
    const before = await Deno.readTextFile(configPath);
    const result = await runCopilotReviewSetup({
      configPath,
      deps: harness([]).deps,
    });
    assertEquals(result.ok, false);
    assertEquals(await Deno.readTextFile(configPath), before);
  });
});

Deno.test("copilot review setup - non-interactive never prompts and leaves the config untouched (Issue #2701)", async () => {
  for (const content of [{}, { copilot_code_review: "off" }]) {
    await withConfig(content, async (configPath) => {
      const before = await Deno.readTextFile(configPath);
      const h = harness(["on"], false);
      const result = await runCopilotReviewSetup({ configPath, deps: h.deps });
      assert(result.ok);
      assertEquals(result.value.prompted, false);
      assertEquals(result.value.changed, false);
      assertEquals(
        result.value.mode,
        (content as { copilot_code_review?: string }).copilot_code_review ??
          "leave",
      );
      assertEquals(h.asked, []);
      assertEquals(await Deno.readTextFile(configPath), before);
    });
  }
});

Deno.test("copilot review setup - an invalid value already in the config fails loud, never asked over (Issue #2701)", async () => {
  await withConfig({ copilot_code_review: "sometimes" }, async (configPath) => {
    const h = harness(["off"]);
    const result = await runCopilotReviewSetup({ configPath, deps: h.deps });
    assertEquals(result.ok, false);
    if (!result.ok) {
      assertStringIncludes(result.error.message, "copilot_code_review");
    }
    assertEquals(h.asked, []);
  });
});

Deno.test("readCopilotCodeReviewSetting / writeCopilotCodeReviewConfig - absent reads as leave; a write is skipped when the file already says it (Issue #2701)", async () => {
  await withConfig(null, async (configPath) => {
    const read = await readCopilotCodeReviewSetting(configPath);
    assertEquals(read, { ok: true, value: "leave" });
  });
  await withConfig({ copilot_code_review: "off" }, async (configPath) => {
    assertEquals(await writeCopilotCodeReviewConfig(configPath, "off"), {
      ok: true,
      value: false,
    });
    assertEquals(await writeCopilotCodeReviewConfig(configPath, "leave"), {
      ok: true,
      value: true,
    });
    assertEquals(await readCopilotCodeReviewSetting(configPath), {
      ok: true,
      value: "leave",
    });
  });
});
