/** Experimental broker process; normal agent startup does not invoke it. */
import type { Command } from "../types.ts";
import { createCredentialBroker } from "../lib/credential_broker.ts";
import type { BrokerService } from "../lib/credential_broker_policy.ts";

export const credentialBrokerCommand: Command = {
  name: "credential-broker",
  description:
    "Experimental API credential broker; does not enable agent containment",
  async execute(args) {
    if (args["experimental"] !== true) {
      return {
        success: false,
        message:
          "credential-broker requires --experimental; network and native CLI integration are unfinished",
      };
    }
    const port = Number(args["port"]);
    if (!Number.isInteger(port) || port < 1024 || port > 65535) {
      return {
        success: false,
        message: "credential-broker requires --port 1024–65535",
      };
    }
    const capability = Deno.env.get("VIBE_BROKER_ACCESS_TOKEN") ?? "";
    const credentials: Partial<Record<BrokerService, string>> = {};
    const names = {
      claude: "ANTHROPIC_API_KEY",
      openai: "OPENAI_API_KEY",
      deepseek: "DEEPSEEK_API_KEY",
      gemini: "GEMINI_API_KEY",
      github: "GH_TOKEN",
    } as const;
    for (const [service, name] of Object.entries(names)) {
      const value = Deno.env.get(name);
      if (value) credentials[service as BrokerService] = value;
    }
    const repositories = typeof args["repos"] === "string"
      ? args["repos"].split(",").map((repo) => repo.trim()).filter(Boolean)
      : [];
    // Fixed loopback bind: exposure to a namespace/sidecar must be an explicit
    // later integration, never an accidental all-interface credential oracle.
    const handler = createCredentialBroker({
      capability,
      credentials,
      repositories,
    });
    const server = Deno.serve({
      hostname: "127.0.0.1",
      port,
      onListen() {
        console.error(
          `Experimental credential broker listening on 127.0.0.1:${port}; containment is NOT enabled`,
        );
      },
    }, handler);
    const stop = () => void server.shutdown();
    Deno.addSignalListener("SIGINT", stop);
    if (Deno.build.os !== "windows") Deno.addSignalListener("SIGTERM", stop);
    try {
      await server.finished;
      return {
        success: true,
        message: "Experimental credential broker stopped",
      };
    } finally {
      Deno.removeSignalListener("SIGINT", stop);
      if (Deno.build.os !== "windows") {
        Deno.removeSignalListener("SIGTERM", stop);
      }
    }
  },
};
