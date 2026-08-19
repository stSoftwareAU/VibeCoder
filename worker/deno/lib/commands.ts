/**
 * Command registry for the Vibe Coder worker.
 *
 * This module provides an extendable command system that allows
 * new functionality to be added without modifying core code.
 *
 * Issue #223 — Registry methods return Result types instead of throwing.
 */

import type { Command, CommandResult, Result, WorkerConfig } from "../types.ts";

/**
 * Command registry interface for managing and executing commands.
 *
 * Methods return Result types for consistent error handling (Issue #223).
 */
export interface CommandRegistry {
  /** Register a new command. Returns error if command name already exists. */
  register(command: Command): Result<void>;
  /** Get a command by name */
  get(name: string): Command | undefined;
  /** Check if a command exists */
  has(name: string): boolean;
  /** Execute a command by name. Returns error if command not found or execution fails. */
  execute(
    name: string,
    args: Record<string, unknown>,
    config: WorkerConfig,
  ): Promise<Result<CommandResult>>;
  /** List all registered command names */
  list(): string[];
  /** Get description for a command */
  describe(name: string): string | undefined;
  /** List all commands with their descriptions */
  listWithDescriptions(): Array<{ name: string; description: string }>;
}

/**
 * Create a new command registry.
 *
 * The registry maintains a map of command names to command implementations.
 * Commands can be registered at any time and executed by name.
 *
 * @returns New command registry instance
 */
export function createCommandRegistry(): CommandRegistry {
  const commands = new Map<string, Command>();

  return {
    register(command: Command): Result<void> {
      if (commands.has(command.name)) {
        return {
          ok: false,
          error: new Error(`Command "${command.name}" is already registered`),
        };
      }
      commands.set(command.name, command);
      return { ok: true, value: undefined };
    },

    get(name: string): Command | undefined {
      return commands.get(name);
    },

    has(name: string): boolean {
      return commands.has(name);
    },

    async execute(
      name: string,
      args: Record<string, unknown>,
      config: WorkerConfig,
    ): Promise<Result<CommandResult>> {
      const command = commands.get(name);
      if (!command) {
        return {
          ok: false,
          error: new Error(`Unknown command: "${name}"`),
        };
      }
      try {
        const result = await command.execute(args, config);
        return { ok: true, value: result };
      } catch (error) {
        return {
          ok: false,
          error: error instanceof Error ? error : new Error(String(error)),
        };
      }
    },

    list(): string[] {
      return Array.from(commands.keys());
    },

    describe(name: string): string | undefined {
      return commands.get(name)?.description;
    },

    listWithDescriptions(): Array<{ name: string; description: string }> {
      return Array.from(commands.entries()).map(([name, cmd]) => ({
        name,
        description: cmd.description,
      }));
    },
  };
}
