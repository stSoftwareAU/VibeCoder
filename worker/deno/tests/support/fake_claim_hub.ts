/**
 * A single fake GitHub issue two fleet hosts can both try to claim.
 *
 * Extracted from `idle_task_cross_host_claim_1139_test.ts` (Issue #1193) so
 * every pre-pipeline route — idle-task wrappers, `add-repo:` requests and
 * `seed-idle-tasks:` requests — can be driven through the *real* claim path
 * (`claimIssue` → `claimRoutedIssue`) over one shared issue rather than each
 * test re-spelling the `gh` surface.
 *
 * Only `gh` is faked: the claim's comment race, its live assignee re-read and
 * its heartbeat-marker scan all run for real against this state.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { CLAIM_MARKER_PREFIX } from "../../lib/claim_issue.ts";
import type { Logger } from "../../types.ts";

/** One comment on the shared issue. */
export interface FakeComment {
  id: number;
  body: string;
  createdAt: string;
  author: string;
}

/** The one issue every host can see, and every mutation made to it. */
export class FakeClaimHub {
  assignees: string[] = [];
  comments: FakeComment[] = [];
  state = "OPEN";
  labels: string[];
  /** Every `gh` invocation, tagged with the host that made it. */
  readonly calls: Array<{ host: string; args: string[] }> = [];
  /** Hook fired just before a host's claim comment is stored. */
  onClaimComment?: (host: string) => void;
  private nextId = 1;

  /**
   * @param fleetUser the one GitHub login every fleet host runs under —
   *   which is why an unassign by a stood-down host would strip the
   *   winner's claim.
   * @param labels the issue's labels, as `gh issue view --json labels`
   *   reports them.
   */
  constructor(readonly fleetUser: string, labels: string[] = []) {
    this.labels = [...labels];
  }

  /** A `gh` runner bound to one host. */
  gh(host: string): (args: string[]) => Promise<string> {
    return (args: string[]) => {
      this.calls.push({ host, args: [...args] });
      return Promise.resolve(this.dispatch(host, args));
    };
  }

  /** Writes this host made to the issue (assign, comment, close, delete). */
  writesBy(host: string): string[][] {
    return this.calls
      .filter((c) => c.host === host && isWrite(c.args))
      .map((c) => c.args);
  }

  addComment(body: string, createdAt: string = new Date().toISOString()): void {
    this.comments.push({
      id: this.nextId++,
      body,
      createdAt,
      author: this.fleetUser,
    });
  }

  private dispatch(host: string, args: string[]): string {
    const jq = jqOf(args);

    if (args[0] === "issue" && args[1] === "view") {
      if (args.includes("labels")) {
        return JSON.stringify({
          labels: this.labels.map((name) => ({ name })),
        });
      }
      if (args.includes("assignees")) return JSON.stringify(this.assignees);
      if (args.includes("state")) return this.state;
      return "";
    }

    if (args[0] === "issue" && args[1] === "edit") {
      const add = args.indexOf("--add-assignee");
      if (add >= 0) {
        const user = args[add + 1]!;
        if (!this.assignees.includes(user)) this.assignees.push(user);
        return "";
      }
      const remove = args.indexOf("--remove-assignee");
      if (remove >= 0) {
        this.assignees = this.assignees.filter((a) => a !== args[remove + 1]);
        return "";
      }
      return "";
    }

    if (args[0] === "issue" && args[1] === "comment") {
      const body = args[args.indexOf("--body") + 1] ?? "";
      if (body.includes(CLAIM_MARKER_PREFIX)) this.onClaimComment?.(host);
      this.addComment(body);
      return "";
    }

    if (args[0] === "issue" && args[1] === "close") {
      this.state = "CLOSED";
      return "";
    }

    if (args[0] === "api" && args[1] === "-X" && args[2] === "DELETE") {
      const id = Number(args[3]!.split("/").pop());
      this.comments = this.comments.filter((c) => c.id !== id);
      return "";
    }

    if (args[0] === "api" && args[1]?.endsWith("/comments")) {
      // Heartbeat marker scan — body + author only.
      if (jq.includes("{body: .body, author: .user.login}")) {
        return JSON.stringify(
          this.comments.map((c) => ({ body: c.body, author: c.author })),
        );
      }
      const claims = this.comments.filter((c) =>
        c.body.includes(CLAIM_MARKER_PREFIX)
      );
      // This worker's own claim comment id (the lost-race cleanup).
      if (jq.includes("contains(")) {
        const needle = jq.split('contains("')[1]?.split('")')[0] ?? "";
        const own = this.comments.find((c) => c.body.includes(needle));
        return own ? String(own.id) : "";
      }
      // Stale-claim cleanup — id, created_at, author (no body).
      if (!jq.includes("body: .body")) {
        return JSON.stringify(
          claims.map((c) => ({
            id: c.id,
            created_at: c.createdAt,
            author: c.author,
          })),
        );
      }
      // Race verification — the full claim comment shape.
      return JSON.stringify(
        claims.map((c) => ({
          id: c.id,
          body: c.body,
          created_at: c.createdAt,
          author: c.author,
        })),
      );
    }

    return "";
  }
}

/** The `--jq` expression of a `gh` invocation, or `""`. */
export function jqOf(args: string[]): string {
  const i = args.indexOf("--jq");
  return i >= 0 ? args[i + 1] ?? "" : "";
}

/** Whether a `gh` invocation mutates the issue. */
export function isWrite(args: string[]): boolean {
  if (args[0] === "issue") {
    return args[1] === "edit" || args[1] === "comment" || args[1] === "close";
  }
  return args[0] === "api" && args[1] === "-X";
}

/** A logger that records every message with its context, for assertions. */
export function makeRecordingLogger(): {
  logger: Logger;
  records: Array<[string, unknown]>;
} {
  const records: Array<[string, unknown]> = [];
  const push = (m: string, c?: unknown) => records.push([m, c]);
  const logger: Logger = {
    info: push,
    warn: push,
    error: push,
    debug: push,
    security: () => {},
    skipReason: () => {},
    timing: () => {},
    scanSummary: () => {},
    workerSummary: () => {},
  };
  return { logger, records };
}
