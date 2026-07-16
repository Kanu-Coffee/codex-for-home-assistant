import { pathToFileURL } from "node:url";

import {
  addMemoryEvidence,
  applyMemoryCandidate,
  beginMemoryChange,
  closeMemoryDatabase,
  listMemoryCandidates,
  listMemoryConflicts,
  memoryHistory,
  memoryStatus,
  MemoryError,
  openMemoryDatabase,
  proposeMemory,
  refreshMemory,
  rejectMemoryCandidate,
  rememberExplicitMemory,
  resolveMemoryConflict,
  rollbackMemoryEvent,
  searchMemory,
  showMemorySubject,
  verifyMemoryCandidate,
  verifyMemoryChange,
} from "./ha-memory-core.mjs";
import {
  homeAssistantErrorCode,
  HomeAssistantUnavailableError,
} from "./ha-memory-ha-client.mjs";

class UsageError extends Error {}

const BOOLEAN_OPTIONS = new Set(["force"]);

function parseArguments(args) {
  const positionals = [];
  const options = new Map();
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (!argument.startsWith("--")) {
      positionals.push(argument);
      continue;
    }
    const equals = argument.indexOf("=");
    let name;
    let value;
    if (equals > 2) {
      name = argument.slice(2, equals);
      value = argument.slice(equals + 1);
    } else {
      name = argument.slice(2);
      if (BOOLEAN_OPTIONS.has(name)) {
        value = true;
      } else if (index + 1 < args.length) {
        value = args[index + 1];
        index += 1;
      } else {
        value = true;
      }
    }
    const existing = options.get(name);
    if (existing === undefined) options.set(name, value);
    else if (Array.isArray(existing)) existing.push(value);
    else options.set(name, [existing, value]);
  }
  return { positionals, options };
}

function option(parsed, name, fallback = undefined) {
  const value = parsed.options.get(name);
  if (value === undefined) return fallback;
  return Array.isArray(value) ? value.at(-1) : value;
}

function optionValues(parsed, name) {
  const value = parsed.options.get(name);
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

function requiredOption(parsed, name) {
  const value = option(parsed, name);
  if (typeof value !== "string" || value.length === 0) {
    throw new UsageError(`--${name} is required`);
  }
  return value;
}

function positiveInteger(value, label, fallback = undefined) {
  if (value === undefined && fallback !== undefined) return fallback;
  const parsed =
    typeof value === "string" && /^[1-9][0-9]*$/u.test(value)
      ? Number(value)
      : Number.NaN;
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new UsageError(`${label} must be a positive integer`);
  }
  return parsed;
}

function jsonValue(value, label) {
  if (typeof value !== "string") throw new UsageError(`${label} is required`);
  try {
    return JSON.parse(value);
  } catch {
    throw new UsageError(`${label} must contain valid JSON`);
  }
}

function requirePositional(values, index, label) {
  const value = values[index];
  if (typeof value !== "string" || value.length === 0) {
    throw new UsageError(`${label} is required`);
  }
  return value;
}

function commandHelp() {
  return {
    usage: "ha-memory COMMAND [OPTIONS]",
    commands: {
      init: "Create or validate the local SQLite store without network access",
      refresh: "Refresh the HA catalog through a fresh Core WebSocket API session",
      search: "Return only bounded, relevant active memory",
      show: "Show one exact active subject",
      remember: "Verify and apply one unambiguous durable fact stated directly by the user",
      candidate: "add, evidence, verify, apply, reject, or list candidates",
      change: "begin or verify a Home Assistant change",
      conflicts: "List conflicts",
      conflict: "Resolve a conflict from explicit user direction",
      history: "Show bounded history-preserving audit events",
      rollback: "Create a compensating rollback for a reversible memory event",
      status: "Show schema, freshness, pending, and degraded status",
    },
  };
}

async function executeCandidateCommand(db, parsed) {
  const subcommand = requirePositional(parsed.positionals, 1, "candidate subcommand");
  if (subcommand === "add") {
    return proposeMemory(db, {
      subject: requiredOption(parsed, "subject"),
      memoryType: requiredOption(parsed, "memory-type"),
      key: requiredOption(parsed, "key"),
      value: jsonValue(requiredOption(parsed, "value-json"), "--value-json"),
      source: requiredOption(parsed, "source"),
      sourceRef: requiredOption(parsed, "source-ref"),
    });
  }
  if (subcommand === "evidence") {
    return addMemoryEvidence(
      db,
      requirePositional(parsed.positionals, 2, "candidate ID"),
      requiredOption(parsed, "evidence-type"),
      requiredOption(parsed, "detail"),
    );
  }
  if (subcommand === "verify") {
    return verifyMemoryCandidate(
      db,
      requirePositional(parsed.positionals, 2, "candidate ID"),
      requiredOption(parsed, "method"),
      { changeId: option(parsed, "change-id") },
    );
  }
  if (subcommand === "apply") {
    return applyMemoryCandidate(
      db,
      requirePositional(parsed.positionals, 2, "candidate ID"),
    );
  }
  if (subcommand === "reject") {
    return rejectMemoryCandidate(
      db,
      requirePositional(parsed.positionals, 2, "candidate ID"),
      requiredOption(parsed, "reason"),
    );
  }
  if (subcommand === "list") {
    return listMemoryCandidates(db, {
      status: option(parsed, "status", "pending"),
      limit: positiveInteger(option(parsed, "limit"), "--limit", 20),
      subject: requiredOption(parsed, "subject"),
    });
  }
  throw new UsageError(`Unknown candidate subcommand: ${subcommand}`);
}

async function executeRememberCommand(db, parsed) {
  return rememberExplicitMemory(db, {
    subject: requiredOption(parsed, "subject"),
    memoryType: requiredOption(parsed, "memory-type"),
    key: requiredOption(parsed, "key"),
    value: jsonValue(requiredOption(parsed, "value-json"), "--value-json"),
    sourceRef: requiredOption(parsed, "source-ref"),
  });
}

function changeSubjects(parsed) {
  const subjectsJson = option(parsed, "subjects-json");
  if (typeof subjectsJson === "string") {
    const parsedSubjects = jsonValue(subjectsJson, "--subjects-json");
    if (!Array.isArray(parsedSubjects)) {
      throw new UsageError("--subjects-json must contain an array");
    }
    return parsedSubjects;
  }
  const subjects = optionValues(parsed, "subject");
  if (subjects.length === 0) {
    throw new UsageError("At least one --subject or --subjects-json is required");
  }
  return subjects;
}

async function executeChangeCommand(db, parsed) {
  const subcommand = requirePositional(parsed.positionals, 1, "change subcommand");
  if (subcommand === "begin") {
    return beginMemoryChange(
      db,
      requiredOption(parsed, "summary"),
      changeSubjects(parsed),
      jsonValue(requiredOption(parsed, "expect-json"), "--expect-json"),
    );
  }
  if (subcommand === "verify") {
    return verifyMemoryChange(
      db,
      requirePositional(parsed.positionals, 2, "change ID"),
      jsonValue(requiredOption(parsed, "expect-json"), "--expect-json"),
    );
  }
  throw new UsageError(`Unknown change subcommand: ${subcommand}`);
}

export async function executeMemoryCli(argv) {
  const parsed = parseArguments(argv);
  const command = parsed.positionals[0] ?? "help";
  if (["help", "--help", "-h"].includes(command)) return commandHelp();

  const dbPath =
    typeof option(parsed, "db") === "string"
      ? option(parsed, "db")
      : process.env.HA_MEMORY_DB;
  const db = openMemoryDatabase(dbPath);
  try {
    if (command === "init") {
      return {
        initialized: true,
        network_accessed: false,
        ...memoryStatus(db, dbPath),
      };
    }
    if (command === "refresh") {
      const ifStale = option(parsed, "if-stale");
      return await refreshMemory(db, {
        force: option(parsed, "force", false) === true,
        ifStaleSeconds:
          ifStale === undefined
            ? null
            : positiveInteger(ifStale, "--if-stale"),
      });
    }
    if (command === "search") {
      return searchMemory(
        db,
        requirePositional(parsed.positionals, 1, "search query"),
        {
          limit: positiveInteger(option(parsed, "limit"), "--limit", 8),
          subject: option(parsed, "subject"),
        },
      );
    }
    if (command === "show") {
      return showMemorySubject(
        db,
        requirePositional(parsed.positionals, 1, "subject"),
      );
    }
    if (command === "remember") return await executeRememberCommand(db, parsed);
    if (command === "candidate") return await executeCandidateCommand(db, parsed);
    if (command === "change") return await executeChangeCommand(db, parsed);
    if (command === "conflicts") {
      return listMemoryConflicts(db, {
        status: option(parsed, "status", "open"),
        limit: positiveInteger(option(parsed, "limit"), "--limit", 20),
      });
    }
    if (command === "conflict") {
      const subcommand = requirePositional(
        parsed.positionals,
        1,
        "conflict subcommand",
      );
      if (subcommand !== "resolve") {
        throw new UsageError(`Unknown conflict subcommand: ${subcommand}`);
      }
      return resolveMemoryConflict(
        db,
        requirePositional(parsed.positionals, 2, "conflict ID"),
        requiredOption(parsed, "winner"),
        requiredOption(parsed, "reason"),
      );
    }
    if (command === "history") {
      return memoryHistory(db, {
        subject: option(parsed, "subject"),
        limit: positiveInteger(option(parsed, "limit"), "--limit", 30),
      });
    }
    if (command === "rollback") {
      return rollbackMemoryEvent(
        db,
        requirePositional(parsed.positionals, 1, "event ID"),
        requiredOption(parsed, "reason"),
      );
    }
    if (command === "status") return memoryStatus(db, dbPath);
    throw new UsageError(`Unknown command: ${command}`);
  } finally {
    closeMemoryDatabase(db, dbPath);
  }
}

function errorPayload(error) {
  if (error instanceof MemoryError) {
    return { error: error.code, message: error.message, details: error.details ?? null };
  }
  if (error instanceof HomeAssistantUnavailableError) {
    return {
      error: "ha_unavailable",
      reason: homeAssistantErrorCode(error),
      message: error.message,
    };
  }
  if (error instanceof UsageError) {
    return { error: "usage", message: error.message, ...commandHelp() };
  }
  return { error: "internal_error", message: "ha-memory failed without exposing details" };
}

async function main() {
  try {
    const result = await executeMemoryCli(process.argv.slice(2));
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    process.stderr.write(`${JSON.stringify(errorPayload(error))}\n`);
    if (error instanceof UsageError) process.exitCode = 64;
    else if (error instanceof HomeAssistantUnavailableError) process.exitCode = 69;
    else if (error instanceof MemoryError) process.exitCode = 1;
    else process.exitCode = 70;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
