/** Evidence for a synthetic separate-container probe, not native CLI acceptance. */
import type { NamespaceEvidence } from "./agent_namespace_evidence.ts";

/** Recognise the planted plaintext marker without disclosing it in evidence. */
export async function countSyntheticCredentialMatches(
  value: string,
  expectedHash: string,
): Promise<number> {
  let matches = 0;
  for (const match of value.matchAll(/synthetic-[a-f0-9-]{36}/g)) {
    const bytes = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(match[0]),
    );
    const hash = Array.from(
      new Uint8Array(bytes),
      (byte) => byte.toString(16).padStart(2, "0"),
    ).join("");
    if (hash === expectedHash) matches++;
  }
  return matches;
}

export interface AgentContainerEvidence extends NamespaceEvidence {
  rootReadOnly: boolean;
  socketReadOnly: boolean;
  proxyVariablesPresent: boolean;
  visibility: {
    privatePathReadable: boolean;
    secretMatches: number;
    processEnvironmentsRead: number;
    regularDescriptorsRead: number;
  };
}

export interface BrokerWitness {
  fileMatches: boolean;
  environmentMatches: boolean;
  descriptorMatches: boolean;
  authenticatedRequests: number;
}

export function assertSeparateContainerEvidence(
  before: NamespaceEvidence,
  agent: AgentContainerEvidence,
  after: NamespaceEvidence,
  witness: BrokerWitness,
): void {
  for (
    const [name, sample] of [["before", before], ["after", after]] as const
  ) {
    if (!sample.directTcp.ipv4 || !sample.directTcp.ipv6) {
      throw new Error(`${name} control could not reach both fixture listeners`);
    }
    for (const namespace of ["net", "pid", "mnt"] as const) {
      if (!sample.namespaces[namespace]) {
        throw new Error(`${name} namespace control is missing`);
      }
    }
  }
  // Default Docker containers may share the user namespace. The distinct
  // network, PID and mount namespaces are the boundaries this probe needs.
  for (const name of ["net", "pid", "mnt"] as const) {
    if (
      !agent.namespaces[name] ||
      agent.namespaces[name] === before.namespaces[name] ||
      before.namespaces[name] !== after.namespaces[name]
    ) {
      throw new Error(`${name} namespace was not isolated`);
    }
  }
  if (agent.directTcp.ipv4 !== false || agent.directTcp.ipv6 !== false) {
    throw new Error("Direct TCP escaped the agent container");
  }
  for (const sample of [before, agent, after]) {
    for (const name of ["effective", "permitted", "bounding"] as const) {
      const value = sample.capabilities[name];
      if (typeof value !== "string" || !/^0+$/.test(value)) {
        throw new Error("Capabilities were retained or unmeasured");
      }
    }
    if (sample.noNewPrivileges !== 1 || sample.seccomp !== 2) {
      throw new Error("Production process hardening was lost");
    }
    if (sample.broker !== "passed") {
      throw new Error("Broker checks did not pass");
    }
  }
  if (
    agent.rootReadOnly !== true || agent.socketReadOnly !== true ||
    agent.proxyVariablesPresent !== false
  ) {
    throw new Error("Read-only mounts or proxy-free direct checks were lost");
  }
  const visibility = agent.visibility;
  if (
    visibility.privatePathReadable !== false || visibility.secretMatches !== 0
  ) {
    throw new Error("The broker credential was visible to the agent");
  }
  if (
    !Number.isSafeInteger(visibility.processEnvironmentsRead) ||
    visibility.processEnvironmentsRead < 1 ||
    !Number.isSafeInteger(visibility.regularDescriptorsRead) ||
    visibility.regularDescriptorsRead < 1
  ) {
    throw new Error(
      "Credential visibility checks did not read their positive controls",
    );
  }
  if (
    !witness.fileMatches || !witness.environmentMatches ||
    !witness.descriptorMatches
  ) {
    throw new Error("The synthetic broker credential was not actually planted");
  }
  if (witness.authenticatedRequests !== 6) {
    throw new Error("Unexpected authenticated upstream request count");
  }
}
