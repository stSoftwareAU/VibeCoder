/** Facts from real child processes, used by the synthetic Linux CI probe. */
export interface NamespaceEvidence {
  namespaces: Record<"user" | "net" | "pid" | "mnt", string>;
  capabilities: Record<"effective" | "permitted" | "bounding", string>;
  noNewPrivileges: number;
  seccomp: number;
  directTcp: Record<"ipv4" | "ipv6", boolean>;
  broker: "passed" | "failed";
}

/** A network outage, retained privilege or absent broker must never pass. */
export function assertNamespaceEvidence(
  before: NamespaceEvidence,
  isolated: NamespaceEvidence,
  after: NamespaceEvidence,
): void {
  for (
    const [name, control] of [["before", before], ["after", after]] as const
  ) {
    if (!control.directTcp.ipv4 || !control.directTcp.ipv6) {
      throw new Error(`${name} control could not reach both fixture listeners`);
    }
  }
  for (const name of ["user", "net", "pid", "mnt"] as const) {
    const value = isolated.namespaces[name];
    if (!value || value === before.namespaces[name]) {
      throw new Error(`${name} namespace was not isolated`);
    }
  }
  for (const [name, reachable] of Object.entries(isolated.directTcp)) {
    if (reachable) {
      throw new Error(`Direct ${name} connection escaped the namespace`);
    }
  }
  for (const sample of [before, isolated, after]) {
    for (const [name, value] of Object.entries(sample.capabilities)) {
      if (!/^0+$/.test(value)) {
        throw new Error(`${name} capabilities were retained`);
      }
    }
    if (sample.noNewPrivileges !== 1) {
      throw new Error("no-new-privileges was lost");
    }
    if (sample.seccomp !== 2) throw new Error("seccomp filtering was lost");
    if (sample.broker !== "passed") {
      throw new Error("The broker transport checks failed");
    }
  }
}
