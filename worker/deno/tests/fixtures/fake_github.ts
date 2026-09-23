/**
 * An in-memory GitHub for behaviour tests (Issue #2547).
 *
 * Answers the `gh` invocations the worker's real selection, escalation and
 * close-out code make, through the `ghCommandFn` seam every one of them
 * already accepts. State is plain data — issues, labels and their events,
 * assignees, milestones, comments, PRs and merges — and time is a
 * simulated clock the harness advances, so a run is deterministic.
 *
 * Two GitHub behaviours are modelled because the worker depends on them:
 *
 * - `Closes #N` in a PR body closes the issue **only** when the PR merges
 *   into the default branch. A merge into a milestone branch closes nothing;
 *   the worker must close the issue itself (Issues #1528, #2537).
 * - A merge commit is reachable from the default branch only when the PR
 *   merged into it, which is what the close-out sweep's landing check reads.
 *
 * Any invocation the fake does not recognise is recorded in
 * {@link FakeGitHub.unknownCommands} and answered with an error, so a
 * behaviour test fails loudly instead of the code under test silently
 * taking a fail-open path the fake never exercised.
 *
 * Australian English spelling throughout (behaviour, colour, organisation).
 */

export interface FakeLabelEvent {
  event: "labeled" | "unlabeled";
  label: string;
  actor: string;
  at: string;
}

export interface FakeIssue {
  repo: string;
  number: number;
  title: string;
  body: string;
  author: string;
  labels: string[];
  assignees: string[];
  milestone: string;
  state: "OPEN" | "CLOSED";
  createdAt: string;
  closedAt?: string;
  labelEvents: FakeLabelEvent[];
  comments: Array<{ author: string; body: string; at: string }>;
}

export interface FakePr {
  repo: string;
  number: number;
  title: string;
  body: string;
  author: string;
  head: string;
  base: string;
  state: "OPEN" | "MERGED" | "CLOSED";
  createdAt: string;
  mergedAt?: string;
  closedAt?: string;
  mergeCommit?: string;
}

/** Issue references GitHub's closing keywords make in a PR body. */
function closingRefs(body: string): number[] {
  const refs: number[] = [];
  const re = /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s+#(\d+)/gi;
  for (const m of body.matchAll(re)) refs.push(Number(m[1]));
  return refs;
}

/** The value following `flag` in `args`, if any. */
function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

/** Every value following each occurrence of `flag`. */
function flags(args: string[], name: string): string[] {
  const out: string[] = [];
  args.forEach((a, i) => {
    if (a === name && args[i + 1] !== undefined) out.push(args[i + 1]!);
  });
  return out;
}

export class FakeGitHub {
  readonly issues = new Map<string, FakeIssue>();
  readonly prs = new Map<string, FakePr>();
  readonly defaultBranch: string;
  readonly unknownCommands: string[] = [];
  /** Simulated wall clock, epoch ms. */
  nowMs: number;
  private nextNumber = new Map<string, number>();
  private commitSeq = 0;

  constructor(opts: { startIso: string; defaultBranch?: string }) {
    this.nowMs = Date.parse(opts.startIso);
    this.defaultBranch = opts.defaultBranch ?? "main";
  }

  now(): string {
    return new Date(this.nowMs).toISOString().replace(/\.\d{3}Z$/, "Z");
  }

  advance(minutes: number): void {
    this.nowMs += minutes * 60_000;
  }

  private key(repo: string, n: number): string {
    return `${repo}#${n}`;
  }

  private allocate(repo: string): number {
    const n = (this.nextNumber.get(repo) ?? 0) + 1;
    this.nextNumber.set(repo, n);
    return n;
  }

  // ---------------------------------------------------------------------
  // Test-side setup and actions (what a human or an agent does)
  // ---------------------------------------------------------------------

  addIssue(spec: {
    repo: string;
    title: string;
    body?: string;
    labels?: string[];
    milestone?: string;
    author?: string;
    number?: number;
  }): FakeIssue {
    const number = spec.number ?? this.allocate(spec.repo);
    if (spec.number !== undefined) {
      this.nextNumber.set(
        spec.repo,
        Math.max(this.nextNumber.get(spec.repo) ?? 0, spec.number),
      );
    }
    const author = spec.author ?? "owner";
    const issue: FakeIssue = {
      repo: spec.repo,
      number,
      title: spec.title,
      body: spec.body ?? "",
      author,
      labels: [...(spec.labels ?? [])],
      assignees: [],
      milestone: spec.milestone ?? "",
      state: "OPEN",
      createdAt: this.now(),
      labelEvents: (spec.labels ?? []).map((label) => ({
        event: "labeled" as const,
        label,
        actor: author,
        at: this.now(),
      })),
      comments: [],
    };
    this.issues.set(this.key(spec.repo, number), issue);
    return issue;
  }

  issue(repo: string, n: number): FakeIssue {
    const i = this.issues.get(this.key(repo, n));
    if (!i) throw new Error(`fake: no issue ${repo}#${n}`);
    return i;
  }

  openPr(spec: {
    repo: string;
    title: string;
    body: string;
    author: string;
    head: string;
    base: string;
  }): FakePr {
    const pr: FakePr = {
      ...spec,
      number: this.allocate(spec.repo),
      state: "OPEN",
      createdAt: this.now(),
    };
    this.prs.set(this.key(spec.repo, pr.number), pr);
    return pr;
  }

  /** Merge a PR, closing `Closes #N` issues only on the default branch. */
  mergePr(repo: string, n: number): void {
    const pr = this.prs.get(this.key(repo, n));
    if (!pr || pr.state !== "OPEN") throw new Error(`fake: PR ${n} not open`);
    pr.state = "MERGED";
    pr.mergedAt = this.now();
    pr.closedAt = pr.mergedAt;
    pr.mergeCommit = `c${(++this.commitSeq).toString(16).padStart(39, "0")}`;
    if (pr.base === this.defaultBranch) {
      for (const ref of closingRefs(pr.body)) {
        const issue = this.issues.get(this.key(repo, ref));
        if (issue && issue.state === "OPEN") this.close(issue);
      }
    }
  }

  private close(issue: FakeIssue): void {
    issue.state = "CLOSED";
    issue.closedAt = this.now();
  }

  private addLabel(issue: FakeIssue, label: string, actor: string): void {
    if (issue.labels.includes(label)) return;
    issue.labels.push(label);
    issue.labelEvents.push({ event: "labeled", label, actor, at: this.now() });
  }

  private removeLabel(issue: FakeIssue, label: string, actor: string): void {
    if (!issue.labels.includes(label)) return;
    issue.labels = issue.labels.filter((l) => l !== label);
    issue.labelEvents.push({
      event: "unlabeled",
      label,
      actor,
      at: this.now(),
    });
  }

  // ---------------------------------------------------------------------
  // JSON shapes
  // ---------------------------------------------------------------------

  private issueJson(i: FakeIssue): Record<string, unknown> {
    return {
      number: i.number,
      title: i.title,
      body: i.body,
      url: `https://github.com/${i.repo}/issues/${i.number}`,
      state: i.state,
      labels: i.labels.map((name) => ({ name })),
      assignees: i.assignees.map((login) => ({ login })),
      author: { login: i.author },
      milestone: i.milestone ? { title: i.milestone } : null,
      createdAt: i.createdAt,
      updatedAt: i.closedAt ?? i.createdAt,
      closedAt: i.closedAt ?? null,
    };
  }

  private prJson(p: FakePr): Record<string, unknown> {
    return {
      number: p.number,
      title: p.title,
      body: p.body,
      state: p.state,
      author: { login: p.author },
      headRefName: p.head,
      baseRefName: p.base,
      isDraft: false,
      createdAt: p.createdAt,
      mergedAt: p.mergedAt ?? null,
      closedAt: p.closedAt ?? null,
      mergeCommit: p.mergeCommit ? { oid: p.mergeCommit } : null,
      url: `https://github.com/${p.repo}/pull/${p.number}`,
    };
  }

  // ---------------------------------------------------------------------
  // The `gh` seam
  // ---------------------------------------------------------------------

  /** Acting login for writes; the harness sets it per host. */
  actor = "bot";

  gh = (args: string[]): Promise<string> => {
    try {
      const out = this.dispatch(args);
      if (out !== undefined) return Promise.resolve(out);
    } catch (err) {
      return Promise.reject(err);
    }
    this.unknownCommands.push(args.join(" ").slice(0, 200));
    return Promise.reject(
      new Error(`fake gh: unsupported command: ${args.join(" ")}`),
    );
  };

  private dispatch(args: string[]): string | undefined {
    const [a0, a1] = args;
    const repo = flag(args, "--repo") ?? flag(args, "-R") ?? "";
    if (a0 === "issue") return this.issueCmd(a1, args, repo);
    if (a0 === "pr") return this.prCmd(a1, args, repo);
    if (a0 === "label") return "";
    if (a0 === "api") return this.api(args);
    return undefined;
  }

  private issueCmd(
    sub: string | undefined,
    args: string[],
    repo: string,
  ): string | undefined {
    if (sub === "list") {
      const state = flag(args, "--state") ?? "open";
      const milestone = flag(args, "--milestone");
      const labelFilters = flags(args, "--label");
      const out = [...this.issues.values()].filter((i) =>
        i.repo === repo &&
        (state === "all" || i.state === state.toUpperCase()) &&
        (milestone === undefined || i.milestone === milestone) &&
        labelFilters.every((l) => i.labels.includes(l))
      );
      return JSON.stringify(out.map((i) => this.issueJson(i)));
    }
    const n = Number(args[2]);
    const issue = this.issues.get(this.key(repo, n));
    if (sub === "view") {
      if (!issue) throw new Error(`fake gh: issue ${repo}#${n} not found`);
      return JSON.stringify(this.issueJson(issue));
    }
    if (!issue) return undefined;
    if (sub === "edit") {
      for (const l of flags(args, "--add-label")) {
        for (const one of l.split(",")) this.addLabel(issue, one, this.actor);
      }
      for (const l of flags(args, "--remove-label")) {
        for (const one of l.split(",")) {
          this.removeLabel(issue, one, this.actor);
        }
      }
      for (const a of flags(args, "--add-assignee")) {
        const login = a === "@me" ? this.actor : a;
        if (!issue.assignees.includes(login)) issue.assignees.push(login);
      }
      for (const a of flags(args, "--remove-assignee")) {
        const login = a === "@me" ? this.actor : a;
        issue.assignees = issue.assignees.filter((x) => x !== login);
      }
      return "";
    }
    if (sub === "close") {
      const body = flag(args, "--comment") ?? flag(args, "-c");
      if (body) {
        issue.comments.push({ author: this.actor, body, at: this.now() });
      }
      if (issue.state === "OPEN") this.close(issue);
      return "";
    }
    if (sub === "comment") {
      const body = flag(args, "--body") ?? flag(args, "-b") ?? "";
      issue.comments.push({ author: this.actor, body, at: this.now() });
      return `https://github.com/${repo}/issues/${n}#issuecomment-1`;
    }
    return undefined;
  }

  private prCmd(
    sub: string | undefined,
    args: string[],
    repo: string,
  ): string | undefined {
    if (sub === "list") {
      const state = flag(args, "--state") ?? "open";
      const author = flag(args, "--author");
      const head = flag(args, "--head");
      const base = flag(args, "--base");
      const limit = Number(flag(args, "--limit") ?? "30");
      const want = (p: FakePr): boolean => {
        if (state === "all") return true;
        if (state === "open") return p.state === "OPEN";
        if (state === "merged") return p.state === "MERGED";
        // gh's `closed` includes merged PRs.
        return p.state !== "OPEN";
      };
      const out = [...this.prs.values()]
        .filter((p) =>
          p.repo === repo && want(p) &&
          (author === undefined || p.author === author) &&
          (head === undefined || p.head === head) &&
          (base === undefined || p.base === base)
        )
        .sort((x, y) => y.number - x.number)
        .slice(0, limit);
      return JSON.stringify(out.map((p) => this.prJson(p)));
    }
    if (sub === "view") {
      const pr = this.prs.get(this.key(repo, Number(args[2])));
      if (!pr) throw new Error(`fake gh: PR ${repo}#${args[2]} not found`);
      return JSON.stringify(this.prJson(pr));
    }
    return undefined;
  }

  /** Field values passed with `-f`/`-F`/`--field`/`--raw-field`. */
  private fields(args: string[]): Array<[string, string]> {
    const out: Array<[string, string]> = [];
    args.forEach((a, i) => {
      if (["-f", "-F", "--field", "--raw-field"].includes(a)) {
        const kv = args[i + 1] ?? "";
        const eq = kv.indexOf("=");
        if (eq > 0) out.push([kv.slice(0, eq), kv.slice(eq + 1)]);
      }
    });
    return out;
  }

  /** REST writes: comments, labels, assignees, issue state. */
  private apiWrite(
    method: string,
    path: string,
    args: string[],
  ): string | undefined {
    const m = path.match(/^repos\/([^/]+\/[^/]+)(\/.*)$/);
    if (!m) return undefined;
    const repo = m[1]!;
    const rest = m[2]!;
    const fields = this.fields(args);
    const field = (name: string) => fields.find(([k]) => k === name)?.[1];
    if (rest === "/labels" && method === "POST") return "{}";
    const r = rest.match(/^\/issues\/(\d+)(\/[a-z]+)?(?:\/(.+))?$/);
    if (!r) return undefined;
    const issue = this.issues.get(this.key(repo, Number(r[1])));
    if (!issue) throw new Error(`fake gh: issue ${repo}#${r[1]} not found`);
    const sub = r[2] ?? "";
    if (sub === "/comments" && method === "POST") {
      issue.comments.push({
        author: this.actor,
        body: field("body") ?? "",
        at: this.now(),
      });
      return JSON.stringify({ id: issue.comments.length });
    }
    if (sub === "/labels" && method === "POST") {
      for (const [k, v] of fields) {
        if (k.startsWith("labels")) this.addLabel(issue, v, this.actor);
      }
      return "[]";
    }
    if (sub === "/labels" && method === "DELETE" && r[3]) {
      this.removeLabel(issue, decodeURIComponent(r[3]), this.actor);
      return "[]";
    }
    if (sub === "/assignees") {
      const logins = fields.filter(([k]) => k.startsWith("assignees"))
        .map(([, v]) => v);
      if (method === "POST") {
        for (const l of logins) {
          if (!issue.assignees.includes(l)) issue.assignees.push(l);
        }
      } else if (method === "DELETE") {
        issue.assignees = issue.assignees.filter((a) => !logins.includes(a));
      }
      return "{}";
    }
    if (sub === "" && method === "PATCH") {
      if (field("state") === "closed" && issue.state === "OPEN") {
        this.close(issue);
      }
      return JSON.stringify(this.issueJson(issue));
    }
    return undefined;
  }

  private api(args: string[]): string | undefined {
    const method = (flag(args, "-X") ?? flag(args, "--method") ?? "GET")
      .toUpperCase();
    // The path is the first positional argument after `api` that is not a
    // flag's value.
    const valued = new Set([
      "-X",
      "--method",
      "-f",
      "-F",
      "--field",
      "--raw-field",
      "-H",
      "--header",
      "--jq",
      "-q",
      "--input",
    ]);
    let path = "";
    for (let i = 1; i < args.length; i++) {
      const a = args[i]!;
      if (valued.has(a)) {
        i++;
        continue;
      }
      if (!a.startsWith("-")) {
        path = a;
        break;
      }
    }
    if (method !== "GET") return this.apiWrite(method, path, args);
    if (path === "graphql") {
      // Batched GraphQL paths all fall back to REST; exercise that path.
      throw new Error("fake gh: graphql is not modelled");
    }
    const m = path.match(/^repos\/([^/]+\/[^/]+)(\/.*)?$/);
    if (!m) return undefined;
    const repo = m[1]!;
    const rest = (m[2] ?? "").split("?")[0]!;
    if (rest === "") {
      return JSON.stringify({ default_branch: this.defaultBranch });
    }
    let r = rest.match(/^\/issues\/(\d+)\/timeline$/);
    if (r) {
      const issue = this.issues.get(this.key(repo, Number(r[1])));
      if (!issue) return "[]";
      // Timeline is served on the first page only.
      if (/[?&]page=([2-9]|\d{2,})/.test(path)) return "[]";
      return JSON.stringify(issue.labelEvents.map((e) => ({
        event: e.event,
        label: { name: e.label },
        actor: { login: e.actor },
        created_at: e.at,
      })));
    }
    if (/^\/issues\/\d+\/sub_issues$/.test(rest)) return "[]";
    r = rest.match(/^\/issues\/(\d+)\/comments$/);
    if (r) {
      const issue = this.issues.get(this.key(repo, Number(r[1])));
      return JSON.stringify(
        (issue?.comments ?? []).map((c, i) => ({
          id: i + 1,
          body: c.body,
          user: { login: c.author },
          created_at: c.at,
        })),
      );
    }
    if (rest === "/milestones") {
      const titles = new Set(
        [...this.issues.values()]
          .filter((i) => i.repo === repo && i.milestone)
          .map((i) => i.milestone),
      );
      return JSON.stringify([...titles].map((title, idx) => {
        const kids = [...this.issues.values()].filter((i) =>
          i.repo === repo && i.milestone === title
        );
        return {
          number: idx + 1,
          title,
          state: "open",
          open_issues: kids.filter((i) => i.state === "OPEN").length,
          closed_issues: kids.filter((i) => i.state === "CLOSED").length,
        };
      }));
    }
    r = rest.match(/^\/compare\/([^.]+)\.\.\.(.+)$/);
    if (r) {
      const sha = r[2]!;
      const pr = [...this.prs.values()].find((p) => p.mergeCommit === sha);
      const onDefault = pr?.base === this.defaultBranch;
      return JSON.stringify({ status: onDefault ? "behind" : "diverged" });
    }
    return undefined;
  }
}
