/**
 * Enforces the frontmatter rules the skills guide sets for every checked-in
 * Claude Code skill (each `SKILL.md` under `.claude/skills`) and subagent
 * (each markdown file under `.claude/agents`), so a skill or agent cannot
 * silently drift from those rules — or silently disappear from the check if
 * its directory moves (Issue #3298). The rules checked here are: valid YAML
 * frontmatter is present; `name` is kebab-case and (for a skill) matches its
 * folder name; `description` is present, non-empty, at most 1024 characters,
 * free of angle brackets, and (for a skill, not an agent) states when to use
 * the skill via the phrase "Use when".
 */

import { assertEquals, assertRejects } from "@std/assert";
import { parse as parseYaml } from "@std/yaml/parse";

const fromFileUrl = (u: URL) => decodeURIComponent(u.pathname);

const REPO_ROOT = fromFileUrl(new URL("../../../", import.meta.url));
const SKILLS_DIR = `${REPO_ROOT}.claude/skills`;
const AGENTS_DIR = `${REPO_ROOT}.claude/agents`;

type Rule =
  | "no-frontmatter"
  | "yaml-invalid"
  | "name-not-kebab-case"
  | "name-not-folder"
  | "description-missing"
  | "description-too-long"
  | "description-angle-bracket"
  | "description-no-use-when";

interface Problem {
  rule: Rule;
  message: string;
}

const KEBAB_CASE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const MAX_DESCRIPTION = 1024;

type Target = { kind: "skill"; folder: string } | { kind: "agent" };

/** Checks one SKILL.md / agent .md source against the frontmatter rules. */
function frontmatterProblems(source: string, target: Target): Problem[] {
  const lines = source.split(/\r\n|\n/);
  if (lines[0] !== "---") {
    return [{
      rule: "no-frontmatter",
      message: "file does not start with a `---` frontmatter fence",
    }];
  }
  let closingIndex = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i] === "---") {
      closingIndex = i;
      break;
    }
  }
  if (closingIndex === -1) {
    return [{
      rule: "no-frontmatter",
      message: "frontmatter opening `---` has no closing `---`",
    }];
  }

  const yamlSource = lines.slice(1, closingIndex).join("\n");
  let parsed: unknown;
  try {
    parsed = parseYaml(yamlSource);
  } catch (error) {
    return [{
      rule: "yaml-invalid",
      message: `frontmatter YAML failed to parse: ${
        error instanceof Error ? error.message : String(error)
      }`,
    }];
  }
  if (
    typeof parsed !== "object" || parsed === null || Array.isArray(parsed)
  ) {
    return [{
      rule: "yaml-invalid",
      message: `frontmatter did not parse to a plain object, got: ${
        JSON.stringify(parsed)
      }`,
    }];
  }
  const frontmatter = parsed as Record<string, unknown>;

  const problems: Problem[] = [];

  const name = frontmatter["name"];
  if (typeof name !== "string" || !KEBAB_CASE.test(name)) {
    problems.push({
      rule: "name-not-kebab-case",
      message: `name must be kebab-case, got: ${JSON.stringify(name)}`,
    });
  } else if (target.kind === "skill" && name !== target.folder) {
    problems.push({
      rule: "name-not-folder",
      message: `name ${JSON.stringify(name)} must match its folder ${
        JSON.stringify(target.folder)
      }`,
    });
  }

  const description = frontmatter["description"];
  if (typeof description !== "string" || description.trim() === "") {
    problems.push({
      rule: "description-missing",
      message: `description must be a non-empty string, got: ${
        JSON.stringify(description)
      }`,
    });
  } else {
    const length = [...description].length;
    if (length > MAX_DESCRIPTION) {
      problems.push({
        rule: "description-too-long",
        message:
          `description is ${length} characters, over the ${MAX_DESCRIPTION} limit`,
      });
    }
    if (/[<>]/.test(description)) {
      problems.push({
        rule: "description-angle-bracket",
        message: `description must not contain < or >, got: ${
          JSON.stringify(description)
        }`,
      });
    }
    if (target.kind === "skill" && !description.includes("Use when")) {
      problems.push({
        rule: "description-no-use-when",
        message:
          `skill description must state "Use when ..." it applies, got: ${
            JSON.stringify(description)
          }`,
      });
    }
  }

  return problems;
}

/** One entry per checked-in skill: its SKILL.md path and owning folder name. */
async function skillFiles(
  skillsDir: string,
): Promise<{ path: string; folder: string }[]> {
  let entries;
  try {
    entries = await Array.fromAsync(Deno.readDir(skillsDir));
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) {
      throw new Error(
        `skills directory ${skillsDir} not found — a moved directory must not become a silent pass`,
      );
    }
    throw error;
  }

  const found: { path: string; folder: string }[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory) continue;
    const candidate = `${skillsDir}/${entry.name}/SKILL.md`;
    let stat: Deno.FileInfo;
    try {
      stat = await Deno.stat(candidate);
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) continue;
      throw error;
    }
    if (stat.isFile) {
      found.push({ path: candidate, folder: entry.name });
    }
  }

  if (found.length === 0) {
    throw new Error(`no skill file matched ${skillsDir}/*/SKILL.md`);
  }
  found.sort((a, b) => a.path.localeCompare(b.path));
  return found;
}

/** Every checked-in subagent markdown file's path. */
async function agentFiles(agentsDir: string): Promise<string[]> {
  let entries;
  try {
    entries = await Array.fromAsync(Deno.readDir(agentsDir));
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) {
      throw new Error(
        `agents directory ${agentsDir} not found — a moved directory must not become a silent pass`,
      );
    }
    throw error;
  }

  const found: string[] = [];
  for (const entry of entries) {
    if (entry.isFile && entry.name.endsWith(".md")) {
      found.push(`${agentsDir}/${entry.name}`);
    }
  }

  if (found.length === 0) {
    throw new Error(`no agent file matched ${agentsDir}/*.md`);
  }
  found.sort((a, b) => a.localeCompare(b));
  return found;
}

Deno.test(
  "every checked-in skill and agent passes the frontmatter rules (Issue #3298)",
  async () => {
    const skills = await skillFiles(SKILLS_DIR);
    const agents = await agentFiles(AGENTS_DIR);

    assertEquals(
      skills.length > 0,
      true,
      "expected at least one checked-in skill",
    );
    assertEquals(
      agents.length > 0,
      true,
      "expected at least one checked-in agent",
    );

    const problemsWithPaths: string[] = [];
    for (const skill of skills) {
      const source = await Deno.readTextFile(skill.path);
      const relative = skill.path.slice(REPO_ROOT.length);
      for (
        const problem of frontmatterProblems(source, {
          kind: "skill",
          folder: skill.folder,
        })
      ) {
        problemsWithPaths.push(
          `${relative}: ${problem.rule} — ${problem.message}`,
        );
      }
    }
    for (const agentPath of agents) {
      const source = await Deno.readTextFile(agentPath);
      const relative = agentPath.slice(REPO_ROOT.length);
      for (const problem of frontmatterProblems(source, { kind: "agent" })) {
        problemsWithPaths.push(
          `${relative}: ${problem.rule} — ${problem.message}`,
        );
      }
    }

    assertEquals(problemsWithPaths, []);
  },
);

/** Builds a minimal SKILL.md / agent .md fixture from a frontmatter body. */
function doc(fields: string): string {
  return `---\n${fields}\n---\n\n# Body\n`;
}

const VALID_SKILL_FIELDS =
  "name: demo-skill\ndescription: Does a thing. Use when asked to do the thing.";
const VALID_AGENT_FIELDS = "name: demo-agent\ndescription: Reviews one thing.";

Deno.test(
  "a valid skill fixture has no problems (Issue #3298)",
  () => {
    assertEquals(
      frontmatterProblems(doc(VALID_SKILL_FIELDS), {
        kind: "skill",
        folder: "demo-skill",
      }),
      [],
    );
  },
);

Deno.test(
  "a valid agent fixture has no problems, proving agents are exempt from Use when (Issue #3298)",
  () => {
    assertEquals(
      frontmatterProblems(doc(VALID_AGENT_FIELDS), { kind: "agent" }),
      [],
    );
  },
);

function rules(problems: Problem[]): Rule[] {
  return problems.map((p) => p.rule);
}

Deno.test(
  "a skill description without 'Use when' is refused (Issue #3298)",
  () => {
    const fields =
      "name: demo-skill\ndescription: Does a thing without saying when.";
    assertEquals(
      rules(frontmatterProblems(doc(fields), {
        kind: "skill",
        folder: "demo-skill",
      })),
      ["description-no-use-when"],
    );
  },
);

Deno.test(
  "a 1025-character description is too long (Issue #3298)",
  () => {
    const description = "Use when " + "x".repeat(1016);
    assertEquals(description.length, 1025);
    const fields = `name: demo-skill\ndescription: ${description}`;
    assertEquals(
      rules(frontmatterProblems(doc(fields), {
        kind: "skill",
        folder: "demo-skill",
      })),
      ["description-too-long"],
    );
  },
);

Deno.test(
  "a 1024-character description is accepted at the boundary (Issue #3298)",
  () => {
    const description = "Use when " + "x".repeat(1015);
    assertEquals(description.length, 1024);
    const fields = `name: demo-skill\ndescription: ${description}`;
    assertEquals(
      frontmatterProblems(doc(fields), {
        kind: "skill",
        folder: "demo-skill",
      }),
      [],
    );
  },
);

Deno.test(
  "a description containing < and > is refused (Issue #3298)",
  () => {
    const fields =
      'name: demo-skill\ndescription: "Does a thing. Use when asked to <do> it."';
    assertEquals(
      rules(frontmatterProblems(doc(fields), {
        kind: "skill",
        folder: "demo-skill",
      })),
      ["description-angle-bracket"],
    );
  },
);

Deno.test(
  "a description containing only < is refused (Issue #3298)",
  () => {
    const fields = 'name: demo-skill\ndescription: "Use when a < b."';
    assertEquals(
      rules(frontmatterProblems(doc(fields), {
        kind: "skill",
        folder: "demo-skill",
      })),
      ["description-angle-bracket"],
    );
  },
);

Deno.test(
  "a non-kebab-case name is refused (Issue #3298)",
  () => {
    const fields =
      "name: Demo_Skill\ndescription: Does a thing. Use when asked to do the thing.";
    assertEquals(
      rules(frontmatterProblems(doc(fields), {
        kind: "skill",
        folder: "Demo_Skill",
      })),
      ["name-not-kebab-case"],
    );
  },
);

Deno.test(
  "a missing name is refused (Issue #3298)",
  () => {
    const fields = "description: Does a thing. Use when asked to do the thing.";
    assertEquals(
      rules(frontmatterProblems(doc(fields), {
        kind: "skill",
        folder: "demo-skill",
      })),
      ["name-not-kebab-case"],
    );
  },
);

Deno.test(
  "a skill name that differs from its folder is refused (Issue #3298)",
  () => {
    assertEquals(
      rules(frontmatterProblems(doc(VALID_SKILL_FIELDS), {
        kind: "skill",
        folder: "other-skill",
      })),
      ["name-not-folder"],
    );
  },
);

Deno.test(
  "a missing description is refused (Issue #3298)",
  () => {
    const fields = "name: demo-skill";
    assertEquals(
      rules(frontmatterProblems(doc(fields), {
        kind: "skill",
        folder: "demo-skill",
      })),
      ["description-missing"],
    );
  },
);

Deno.test(
  "an empty description is refused (Issue #3298)",
  () => {
    const fields = 'name: demo-skill\ndescription: ""';
    assertEquals(
      rules(frontmatterProblems(doc(fields), {
        kind: "skill",
        folder: "demo-skill",
      })),
      ["description-missing"],
    );
  },
);

Deno.test(
  "no frontmatter at all is refused (Issue #3298)",
  () => {
    assertEquals(
      rules(frontmatterProblems("# Just a body\n", {
        kind: "skill",
        folder: "demo-skill",
      })),
      ["no-frontmatter"],
    );
  },
);

Deno.test(
  "invalid YAML in the frontmatter is refused (Issue #3298)",
  () => {
    const fields = "name: [unclosed";
    assertEquals(
      rules(frontmatterProblems(doc(fields), {
        kind: "skill",
        folder: "demo-skill",
      })),
      ["yaml-invalid"],
    );
  },
);

Deno.test(
  "skillFiles rejects an empty skills directory loudly (Issue #3298)",
  async () => {
    const dir = await Deno.makeTempDir();
    try {
      await assertRejects(
        () => skillFiles(dir),
        Error,
        "no skill file matched",
      );
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  },
);

Deno.test(
  "skillFiles rejects a skills directory whose only folder lacks SKILL.md (Issue #3298)",
  async () => {
    const dir = await Deno.makeTempDir();
    try {
      await Deno.mkdir(`${dir}/empty-skill`);
      await assertRejects(
        () => skillFiles(dir),
        Error,
        "no skill file matched",
      );
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  },
);

Deno.test(
  "skillFiles rejects a missing skills directory loudly (Issue #3298)",
  async () => {
    const dir = await Deno.makeTempDir();
    const missing = `${dir}/does-not-exist`;
    try {
      await assertRejects(() => skillFiles(missing), Error, "not found");
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  },
);

Deno.test(
  "agentFiles rejects an empty agents directory loudly (Issue #3298)",
  async () => {
    const dir = await Deno.makeTempDir();
    try {
      await assertRejects(
        () => agentFiles(dir),
        Error,
        "no agent file matched",
      );
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  },
);

Deno.test(
  "skillFiles finds a skill file in a positive fixture (Issue #3298)",
  async () => {
    const dir = await Deno.makeTempDir();
    try {
      await Deno.mkdir(`${dir}/x`);
      await Deno.writeTextFile(`${dir}/x/SKILL.md`, doc(VALID_SKILL_FIELDS));
      assertEquals(await skillFiles(dir), [
        { path: `${dir}/x/SKILL.md`, folder: "x" },
      ]);
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  },
);
