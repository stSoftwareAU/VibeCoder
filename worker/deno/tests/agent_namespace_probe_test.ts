/** The acceptance probe must reject a missing control or a missing boundary. */
import { assertThrows } from "@std/assert";
import {
  assertNamespaceEvidence,
  type NamespaceEvidence,
} from "./support/agent_namespace_evidence.ts";

function evidence(isolated: boolean): NamespaceEvidence {
  return {
    namespaces: {
      user: isolated ? "2" : "1",
      net: isolated ? "4" : "3",
      pid: isolated ? "6" : "5",
      mnt: isolated ? "8" : "7",
    },
    capabilities: { effective: "0", permitted: "0", bounding: "0" },
    noNewPrivileges: 1,
    seccomp: 2,
    directTcp: { ipv4: !isolated, ipv6: !isolated },
    broker: "passed",
  };
}

Deno.test("namespace evidence requires both controls and every isolated namespace", () => {
  assertNamespaceEvidence(evidence(false), evidence(true), evidence(false));
  for (const name of ["user", "net", "pid", "mnt"] as const) {
    const isolated = evidence(true);
    isolated.namespaces[name] = evidence(false).namespaces[name];
    assertThrows(
      () => assertNamespaceEvidence(evidence(false), isolated, evidence(false)),
      Error,
      `${name} namespace`,
    );
    isolated.namespaces[name] = "";
    assertThrows(
      () => assertNamespaceEvidence(evidence(false), isolated, evidence(false)),
      Error,
      `${name} namespace`,
    );
  }
  for (const side of ["before", "after"] as const) {
    const control = evidence(false);
    control.directTcp.ipv4 = false;
    assertThrows(
      () =>
        assertNamespaceEvidence(
          side === "before" ? control : evidence(false),
          evidence(true),
          side === "after" ? control : evidence(false),
        ),
      Error,
      `${side} control`,
    );
  }
});

Deno.test("namespace evidence rejects reachable TCP, lost hardening and missing broker", () => {
  const cases: Array<[string, (value: NamespaceEvidence) => void]> = [
    ["ipv4", (value) => value.directTcp.ipv4 = true],
    ["ipv6", (value) => value.directTcp.ipv6 = true],
    ["effective capabilities", (value) => value.capabilities.effective = "1"],
    ["permitted capabilities", (value) => value.capabilities.permitted = "1"],
    ["bounding capabilities", (value) => value.capabilities.bounding = "1"],
    ["no-new-privileges", (value) => value.noNewPrivileges = 0],
    ["seccomp", (value) => value.seccomp = 0],
    ["broker", (value) => value.broker = "failed"],
  ];
  for (const [message, mutate] of cases) {
    const isolated = evidence(true);
    mutate(isolated);
    assertThrows(
      () => assertNamespaceEvidence(evidence(false), isolated, evidence(false)),
      Error,
      message,
    );
  }
});
