import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

const SERVER_NAME = "codex-ha-memory";
const SERVER_VERSION = "1.0.0";
const DEFAULT_PROTOCOL_VERSION = "2024-11-05";
const CLI_PATH = "/usr/local/bin/ha-memory";
const CLI_TIMEOUT_MS = 90_000;
const MAX_LINE_BYTES = 1024 * 1024;
const MAX_OUTPUT_BYTES = 2 * 1024 * 1024;
const MAX_ERROR_TEXT_BYTES = 4 * 1024;
const MEMORY_TYPES = new Set(["alias", "purpose", "preference", "relationship", "note"]);
const MEMORY_SOURCES = new Set(["user_explicit", "codex_change", "observation", "inference"]);
const EVIDENCE_TYPES = new Set([
  "user_explicit",
  "observation",
  "ha_api",
  "change_verification",
  "manual_review",
]);
const VERIFICATION_METHODS = new Set([
  "user_explicit",
  "repeated_observation",
  "ha_api",
  "change_verification",
]);
const CONFLICT_STATUSES = new Set(["open", "resolved"]);
const CONFLICT_WINNERS = new Set(["candidate", "existing", "ha"]);

const SERVER_INSTRUCTIONS = [
  "Search Home Assistant memory at the start of each Home Assistant request,",
  "using only the current question, named subjects, and a small result limit.",
  "Do not read the SQLite database or load the complete memory store.",
  "New aliases, purposes, preferences, notes, and relationships are",
  "candidates until evidence is added, verification succeeds, and the candidate",
  "is explicitly applied. Never apply a transient state value or an unsupported",
  "inference. Before a Home Assistant change, commit its subjects and expectation",
  "contract when practical; after the change, use memory_verify_change so fresh Home Assistant",
  "API evidence, rather than the intended result, controls the memory update.",
  "For structural facts, current Home Assistant API data outranks memory. For",
  "aliases, purposes, and preferences, explicit user explanations outrank",
  "observations or inference. Expose unresolved conflicts.",
].join(" ");

const idSchema = {
  oneOf: [
    { type: "integer", minimum: 1 },
    { type: "string", pattern: "^[1-9][0-9]*$", maxLength: 20 },
  ],
};

const boundedString = (description, maxLength = 4096) => ({
  type: "string",
  minLength: 1,
  maxLength,
  description,
});

const structuredLabel = (description) => ({
  type: "string",
  minLength: 1,
  maxLength: 200,
  pattern: "^[a-z0-9][a-z0-9._:/@#()+-]*$",
  description,
});

const nullableStringSchema = {
  oneOf: [{ type: "string" }, { type: "null" }],
};

const objectExpectationFields = {
  exists: { type: "boolean" },
  name: nullableStringSchema,
  description: nullableStringSchema,
  area_id: nullableStringSchema,
  device_id: nullableStringSchema,
  active: { type: "boolean" },
};

const objectExpectation = {
  type: "object",
  properties: objectExpectationFields,
  minProperties: 1,
  additionalProperties: false,
};

const expectationsSchema = {
  type: "object",
  minProperties: 1,
  maxProperties: 3,
  properties: {
    objects: {
      oneOf: [
        {
          type: "array",
          minItems: 1,
          maxItems: 50,
          items: {
            type: "object",
            properties: {
              subject: boundedString("Declared object subject.", 512),
              ...objectExpectationFields,
            },
            required: ["subject"],
            minProperties: 2,
            additionalProperties: false,
          },
        },
        {
          type: "object",
          minProperties: 1,
          maxProperties: 50,
          additionalProperties: objectExpectation,
        },
      ],
    },
    relationships: {
      type: "array",
      minItems: 1,
      maxItems: 50,
      items: {
        type: "object",
        properties: {
          source: boundedString("Declared source subject.", 512),
          relation: boundedString("Relationship name.", 80),
          target: boundedString("Declared target subject.", 512),
          exists: { type: "boolean", default: true },
        },
        required: ["source", "relation", "target"],
        additionalProperties: false,
      },
    },
    states: {
      type: "object",
      minProperties: 1,
      maxProperties: 50,
      additionalProperties: {
        type: "object",
        minProperties: 1,
        properties: {
          exists: { type: "boolean" },
          state: nullableStringSchema,
          attributes: {
            type: "object",
            minProperties: 1,
            maxProperties: 50,
          },
        },
        additionalProperties: false,
      },
    },
  },
  additionalProperties: false,
  description:
    "Pre-change expectation contract. Values are compared transiently; only its digest, field summary, and boolean results are retained.",
};

const readAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};

const writeAnnotations = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: false,
};

const tools = [
  {
    name: "memory_search",
    title: "Search Home Assistant memory",
    description:
      "Return a bounded, relevance-ranked subset of verified Home Assistant memory for the current request.",
    inputSchema: {
      type: "object",
      properties: {
        query: boundedString(
          "Question keywords, alias, entity ID, or relationship to search.",
          256,
        ),
        limit: {
          type: "integer",
          minimum: 1,
          maximum: 20,
          default: 8,
          description: "Maximum number of results.",
        },
        subject: boundedString("Optional exact subject used to narrow the search.", 512),
      },
      required: ["query"],
      additionalProperties: false,
    },
    annotations: readAnnotations,
  },
  {
    name: "memory_show",
    title: "Show one Home Assistant subject",
    description:
      "Return canonical facts, applied memory, relationships, and open conflicts for one exact subject.",
    inputSchema: {
      type: "object",
      properties: {
        subject: boundedString("Exact entity, device, area, automation, or memory subject.", 512),
      },
      required: ["subject"],
      additionalProperties: false,
    },
    annotations: readAnnotations,
  },
  {
    name: "memory_propose",
    title: "Propose a memory candidate",
    description:
      "Store a durable user expression or observation as a candidate; this does not make it active memory.",
    inputSchema: {
      type: "object",
      properties: {
        subject: boundedString("Entity, device, area, automation, or user-preference subject.", 512),
        memory_type: {
          type: "string",
          enum: ["alias", "purpose", "preference", "relationship", "note"],
          description: "Memory category.",
        },
        key: boundedString("Stable field or relationship key.", 80),
        value: {
          oneOf: [
            { type: "string", minLength: 1, maxLength: 4096 },
            {
              type: "array",
              minItems: 1,
              maxItems: 20,
              uniqueItems: true,
              items: { type: "string", minLength: 1, maxLength: 500 },
            },
            {
              type: "object",
              properties: {
                relation: boundedString("Relationship name.", 80),
                target: boundedString("Relationship target kind:id.", 512),
              },
              required: ["relation", "target"],
              additionalProperties: false,
            },
          ],
          description: "Type-specific durable semantic value: alias uses a string or up to 20 strings, relationship uses exactly relation and target, and purpose/preference/note use a string. Never include current state, timestamps, credentials, or raw transcripts.",
        },
        source: {
          type: "string",
          enum: ["user_explicit", "codex_change", "observation", "inference"],
          description: "Candidate provenance class.",
        },
        source_ref: structuredLabel("Lowercase structured provenance label, not quoted conversation or state data."),
      },
      required: ["subject", "memory_type", "key", "value", "source", "source_ref"],
      additionalProperties: false,
    },
    annotations: writeAnnotations,
  },
  {
    name: "memory_add_evidence",
    title: "Add evidence to a candidate",
    description:
      "Attach bounded, non-secret evidence to a pending memory candidate without applying it.",
    inputSchema: {
      type: "object",
      properties: {
        candidate_id: { ...idSchema, description: "Candidate identifier." },
        evidence_type: {
          type: "string",
          enum: [
            "user_explicit",
            "observation",
            "ha_api",
            "change_verification",
            "manual_review",
          ],
          description: "Evidence class.",
        },
        detail: structuredLabel("Lowercase structured evidence label; never include a token, timestamp, state assignment, or raw transcript."),
      },
      required: ["candidate_id", "evidence_type", "detail"],
      additionalProperties: false,
    },
    annotations: writeAnnotations,
  },
  {
    name: "memory_verify_candidate",
    title: "Verify a memory candidate",
    description:
      "Run the selected verification method and record its result; verification does not silently apply the candidate.",
    inputSchema: {
      type: "object",
      properties: {
        candidate_id: { ...idSchema, description: "Candidate identifier." },
        method: {
          type: "string",
          enum: [
            "user_explicit",
            "repeated_observation",
            "ha_api",
            "change_verification",
          ],
          description: "Verification method supported by ha-memory.",
        },
        change_id: { ...idSchema, description: "Optional related change identifier." },
      },
      required: ["candidate_id", "method"],
      additionalProperties: false,
    },
    annotations: writeAnnotations,
  },
  {
    name: "memory_apply_candidate",
    title: "Apply a verified candidate",
    description:
      "Promote a verified, non-conflicting candidate into active memory according to source-precedence rules.",
    inputSchema: {
      type: "object",
      properties: {
        candidate_id: { ...idSchema, description: "Verified candidate identifier." },
      },
      required: ["candidate_id"],
      additionalProperties: false,
    },
    annotations: writeAnnotations,
  },
  {
    name: "memory_begin_change",
    title: "Begin a Home Assistant change record",
    description:
      "Commit the intended subjects and expectation contract before mutation, without claiming success.",
    inputSchema: {
      type: "object",
      properties: {
        summary: boundedString("Concise intended change summary.", 500),
        subjects: {
          type: "array",
          minItems: 1,
          maxItems: 50,
          uniqueItems: true,
          items: boundedString("Affected subject.", 512),
          description: "Entities, devices, areas, or automations expected to change, including a subject expected to be created.",
        },
        expectations: expectationsSchema,
      },
      required: ["summary", "subjects", "expectations"],
      additionalProperties: false,
    },
    annotations: writeAnnotations,
  },
  {
    name: "memory_verify_change",
    title: "Verify a Home Assistant change",
    description:
      "Re-read Home Assistant through its API and compare the same expectation contract committed before the change.",
    inputSchema: {
      type: "object",
      properties: {
        change_id: { ...idSchema, description: "Change record identifier." },
        expectations: expectationsSchema,
      },
      required: ["change_id", "expectations"],
      additionalProperties: false,
    },
    annotations: writeAnnotations,
  },
  {
    name: "memory_status",
    title: "Show Home Assistant memory status",
    description:
      "Return schema, bootstrap, freshness, and degraded-state information without loading memory contents.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
    annotations: readAnnotations,
  },
  {
    name: "memory_history",
    title: "Show memory history",
    description:
      "Return a bounded audit history, optionally limited to one subject.",
    inputSchema: {
      type: "object",
      properties: {
        subject: boundedString("Optional exact subject.", 512),
        limit: {
          type: "integer",
          minimum: 1,
          maximum: 100,
          default: 30,
          description: "Maximum number of audit events.",
        },
      },
      additionalProperties: false,
    },
    annotations: readAnnotations,
  },
  {
    name: "memory_conflicts",
    title: "List memory conflicts",
    description:
      "Return a bounded list of unresolved or resolved conflicts and their non-secret provenance.",
    inputSchema: {
      type: "object",
      properties: {
        status: {
          type: "string",
          enum: ["open", "resolved"],
          description: "Optional conflict status filter; open is the default.",
        },
        limit: {
          type: "integer",
          minimum: 1,
          maximum: 100,
          default: 20,
          description: "Maximum number of conflicts.",
        },
      },
      additionalProperties: false,
    },
    annotations: readAnnotations,
  },
  {
    name: "memory_resolve_conflict",
    title: "Resolve a memory conflict",
    description:
      "Resolve one conflict with an explicit winner and reason while preserving both sides in history.",
    inputSchema: {
      type: "object",
      properties: {
        conflict_id: { ...idSchema, description: "Conflict identifier." },
        winner: {
          type: "string",
          enum: ["candidate", "existing", "ha"],
          description: "Semantic side to retain, or ha for a canonical/change-result conflict.",
        },
        reason: boundedString("Concise resolution reason.", 500),
      },
      required: ["conflict_id", "winner", "reason"],
      additionalProperties: false,
    },
    annotations: {
      ...writeAnnotations,
      destructiveHint: true,
    },
  },
  {
    name: "memory_rollback",
    title: "Roll back a memory event",
    description:
      "Create a compensating memory event for a prior change; this never rolls Home Assistant itself back.",
    inputSchema: {
      type: "object",
      properties: {
        event_id: { ...idSchema, description: "Audit event identifier to compensate." },
        reason: boundedString("Explicit rollback reason.", 500),
      },
      required: ["event_id", "reason"],
      additionalProperties: false,
    },
    annotations: {
      ...writeAnnotations,
      destructiveHint: true,
    },
  },
];

const toolByName = new Map(tools.map((tool) => [tool.name, tool]));

class InvalidToolArguments extends Error {}

function hasOwn(value, key) {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function requireObject(value, label) {
  if (value === undefined) return {};
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new InvalidToolArguments(`${label} must be an object`);
  }
  return value;
}

function requireString(args, key, { optional = false, maxLength = 4096 } = {}) {
  if (!hasOwn(args, key)) {
    if (optional) return undefined;
    throw new InvalidToolArguments(`${key} is required`);
  }
  const value = args[key];
  if (
    typeof value !== "string" ||
    value.trim() === "" ||
    value.length > maxLength ||
    /[\0\r\n]/u.test(value)
  ) {
    throw new InvalidToolArguments(`${key} must be a non-empty single-line string`);
  }
  return value;
}

function requireId(args, key, { optional = false } = {}) {
  if (!hasOwn(args, key)) {
    if (optional) return undefined;
    throw new InvalidToolArguments(`${key} is required`);
  }
  const value = args[key];
  if (
    (Number.isSafeInteger(value) && value > 0) ||
    (typeof value === "string" &&
      /^[1-9][0-9]{0,19}$/u.test(value) &&
      BigInt(value) <= BigInt(Number.MAX_SAFE_INTEGER))
  ) {
    return String(value);
  }
  throw new InvalidToolArguments(`${key} must be a positive integer or non-empty identifier`);
}

function requireChoice(args, key, allowed) {
  const value = requireString(args, key);
  if (!allowed.has(value)) {
    throw new InvalidToolArguments(`${key} is not a supported value`);
  }
  return value;
}

function requireStructuredLabel(args, key) {
  const value = requireString(args, key, { maxLength: 200 });
  if (!/^[a-z0-9][a-z0-9._:/@#()+-]*$/u.test(value)) {
    throw new InvalidToolArguments(`${key} must be a lowercase structured label`);
  }
  return value;
}

function optionalLimit(args, fallback, maximum = 100) {
  const value = hasOwn(args, "limit") ? args.limit : fallback;
  if (!Number.isInteger(value) || value < 1 || value > maximum) {
    throw new InvalidToolArguments(`limit must be an integer from 1 through ${maximum}`);
  }
  return String(value);
}

function requireJsonValue(args, key, maxBytes = 4096) {
  if (!hasOwn(args, key) || args[key] === undefined) {
    throw new InvalidToolArguments(`${key} is required`);
  }
  let encoded;
  try {
    encoded = JSON.stringify(args[key]);
  } catch {
    throw new InvalidToolArguments(`${key} must be JSON serializable`);
  }
  if (encoded === undefined) {
    throw new InvalidToolArguments(`${key} must be JSON serializable`);
  }
  if (Buffer.byteLength(encoded, "utf8") > maxBytes) {
    throw new InvalidToolArguments(`${key} exceeds the ${maxBytes}-byte limit`);
  }
  return encoded;
}

function requireMemoryValue(args, memoryType) {
  if (!hasOwn(args, "value")) {
    throw new InvalidToolArguments("value is required");
  }
  const value = args.value;
  if (memoryType === "alias") {
    const aliases = Array.isArray(value) ? value : [value];
    if (
      aliases.length < 1 ||
      aliases.length > 20 ||
      aliases.some((alias) => typeof alias !== "string" || alias.trim() === "") ||
      new Set(aliases).size !== aliases.length
    ) {
      throw new InvalidToolArguments("alias value must be one string or 1 through 20 unique strings");
    }
  } else if (["purpose", "preference", "note"].includes(memoryType)) {
    if (typeof value !== "string" || value.trim() === "") {
      throw new InvalidToolArguments(`${memoryType} value must be a non-empty string`);
    }
  } else if (memoryType === "relationship") {
    if (
      value === null ||
      typeof value !== "object" ||
      Array.isArray(value) ||
      Object.keys(value).sort().join(",") !== "relation,target" ||
      typeof value.relation !== "string" ||
      value.relation.trim() === "" ||
      typeof value.target !== "string" ||
      value.target.trim() === ""
    ) {
      throw new InvalidToolArguments(
        "relationship value must contain exactly non-empty relation and target strings",
      );
    }
  }
  return requireJsonValue(args, "value");
}

function requireSubjects(args) {
  if (!Array.isArray(args.subjects) || args.subjects.length < 1 || args.subjects.length > 50) {
    throw new InvalidToolArguments("subjects must contain from 1 through 50 items");
  }
  const subjects = args.subjects.map((subject) => {
    if (
      typeof subject !== "string" ||
      subject.trim() === "" ||
      subject.length > 512 ||
      /[\0\r\n]/u.test(subject)
    ) {
      throw new InvalidToolArguments("each subject must be a non-empty single-line string");
    }
    return subject;
  });
  return JSON.stringify(subjects);
}

function cliArgumentsForTool(name, rawArguments) {
  const args = requireObject(rawArguments, "arguments");
  const allowedProperties = new Set(
    Object.keys(toolByName.get(name)?.inputSchema?.properties ?? {}),
  );
  const unknownProperties = Object.keys(args).filter(
    (key) => !allowedProperties.has(key),
  );
  if (unknownProperties.length > 0) {
    throw new InvalidToolArguments(
      `Unsupported argument: ${unknownProperties.sort()[0]}`,
    );
  }
  switch (name) {
    case "memory_search": {
      const result = [
        "search",
        requireString(args, "query", { maxLength: 256 }),
        "--limit",
        optionalLimit(args, 8, 20),
      ];
      const subject = requireString(args, "subject", {
        optional: true,
        maxLength: 512,
      });
      if (subject !== undefined) result.push("--subject", subject);
      return result;
    }
    case "memory_show":
      return ["show", requireString(args, "subject", { maxLength: 512 })];
    case "memory_propose": {
      const memoryType = requireChoice(args, "memory_type", MEMORY_TYPES);
      return [
        "candidate",
        "add",
        "--subject",
        requireString(args, "subject", { maxLength: 512 }),
        "--memory-type",
        memoryType,
        "--key",
        requireString(args, "key", { maxLength: 80 }),
        "--value-json",
        requireMemoryValue(args, memoryType),
        "--source",
        requireChoice(args, "source", MEMORY_SOURCES),
        "--source-ref",
        requireStructuredLabel(args, "source_ref"),
      ];
    }
    case "memory_add_evidence":
      return [
        "candidate",
        "evidence",
        requireId(args, "candidate_id"),
        "--evidence-type",
        requireChoice(args, "evidence_type", EVIDENCE_TYPES),
        "--detail",
        requireStructuredLabel(args, "detail"),
      ];
    case "memory_verify_candidate": {
      const result = [
        "candidate",
        "verify",
        requireId(args, "candidate_id"),
        "--method",
        requireChoice(args, "method", VERIFICATION_METHODS),
      ];
      const changeId = requireId(args, "change_id", { optional: true });
      if (changeId !== undefined) result.push("--change-id", changeId);
      return result;
    }
    case "memory_apply_candidate":
      return ["candidate", "apply", requireId(args, "candidate_id")];
    case "memory_begin_change":
      return [
        "change",
        "begin",
        "--summary",
        requireString(args, "summary", { maxLength: 500 }),
        "--subjects-json",
        requireSubjects(args),
        "--expect-json",
        requireJsonValue(args, "expectations", 16 * 1024),
      ];
    case "memory_verify_change":
      return [
        "change",
        "verify",
        requireId(args, "change_id"),
        "--expect-json",
        requireJsonValue(args, "expectations", 16 * 1024),
      ];
    case "memory_status":
      return ["status"];
    case "memory_history": {
      const result = ["history", "--limit", optionalLimit(args, 30)];
      const subject = requireString(args, "subject", {
        optional: true,
        maxLength: 512,
      });
      if (subject !== undefined) result.push("--subject", subject);
      return result;
    }
    case "memory_conflicts": {
      const result = ["conflicts", "--limit", optionalLimit(args, 20)];
      const status = requireString(args, "status", { optional: true });
      if (status !== undefined) {
        if (!CONFLICT_STATUSES.has(status)) {
          throw new InvalidToolArguments("status must be open or resolved");
        }
        result.push("--status", status);
      }
      return result;
    }
    case "memory_resolve_conflict":
      return [
        "conflict",
        "resolve",
        requireId(args, "conflict_id"),
        "--winner",
        requireChoice(args, "winner", CONFLICT_WINNERS),
        "--reason",
        requireString(args, "reason", { maxLength: 500 }),
      ];
    case "memory_rollback":
      return [
        "rollback",
        requireId(args, "event_id"),
        "--reason",
        requireString(args, "reason", { maxLength: 500 }),
      ];
    default:
      throw new InvalidToolArguments(`Unknown tool: ${name}`);
  }
}

function redactKnownSecrets(value) {
  let redacted = value;
  for (const name of [
    "SUPERVISOR_TOKEN",
    "HA_BROWSER_TOKEN",
    "HOME_ASSISTANT_TOKEN",
    "HASS_TOKEN",
  ]) {
    const secret = process.env[name];
    if (typeof secret === "string" && secret.length >= 4) {
      redacted = redacted.split(secret).join("[REDACTED]");
    }
  }
  return redacted;
}

function sanitizeCliStderr(value) {
  const redacted = redactKnownSecrets(String(value))
    .replace(/Authorization\s*:\s*Bearer\s+[^\s"']+/giu, "Authorization: Bearer [REDACTED]")
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}\b/giu, "Bearer [REDACTED]")
    .replace(
      /\b(SUPERVISOR_TOKEN|HA_BROWSER_TOKEN|HOME_ASSISTANT_TOKEN|HASS_TOKEN)\s*=\s*[^\s]+/giu,
      "$1=[REDACTED]",
    )
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  if (Buffer.byteLength(redacted) <= MAX_ERROR_TEXT_BYTES) return redacted;
  return `${Buffer.from(redacted).subarray(0, MAX_ERROR_TEXT_BYTES).toString("utf8")}…`;
}

function runCli(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(CLI_PATH, args, {
      env: process.env,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    const stdout = [];
    const stderr = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let settled = false;
    let outputLimitExceeded = false;

    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      callback(value);
    };

    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(reject, new Error("ha-memory command timed out"));
    }, CLI_TIMEOUT_MS);

    child.on("error", (error) => {
      finish(reject, new Error(`Unable to start ha-memory (${sanitizeCliStderr(error.code ?? "spawn error")})`));
    });

    child.stdout.on("data", (chunk) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > MAX_OUTPUT_BYTES) {
        outputLimitExceeded = true;
        child.kill("SIGKILL");
        return;
      }
      stdout.push(chunk);
    });

    child.stderr.on("data", (chunk) => {
      stderrBytes += chunk.length;
      if (stderrBytes <= MAX_OUTPUT_BYTES) stderr.push(chunk);
    });

    child.on("close", (code, signal) => {
      if (settled) return;
      if (outputLimitExceeded) {
        finish(reject, new Error("ha-memory output exceeded the response limit"));
        return;
      }
      const stdoutText = Buffer.concat(stdout).toString("utf8").trim();
      const stderrText = sanitizeCliStderr(Buffer.concat(stderr).toString("utf8"));
      if (code !== 0) {
        const detail = stderrText ? `: ${stderrText}` : "";
        const status = signal ? `signal ${signal}` : `status ${code ?? "unknown"}`;
        finish(reject, new Error(`ha-memory exited with ${status}${detail}`));
        return;
      }
      if (stdoutText === "") {
        finish(reject, new Error("ha-memory returned an empty response"));
        return;
      }
      let parsed;
      try {
        parsed = JSON.parse(stdoutText);
      } catch {
        finish(reject, new Error("ha-memory returned invalid JSON"));
        return;
      }
      finish(resolve, parsed);
    });
  });
}

function toolResult(value) {
  return {
    content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
    structuredContent: { result: value },
    isError: false,
  };
}

function toolError(error) {
  const message = sanitizeCliStderr(error instanceof Error ? error.message : String(error));
  return {
    content: [{ type: "text", text: message || "ha-memory tool failed" }],
    structuredContent: { error: message || "ha-memory tool failed" },
    isError: true,
  };
}

function jsonRpcError(id, code, message) {
  return {
    jsonrpc: "2.0",
    id: id ?? null,
    error: { code, message },
  };
}

function jsonRpcResult(id, result) {
  return { jsonrpc: "2.0", id, result };
}

function writeMessage(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

async function handleRequest(message) {
  const objectMessage =
    message !== null && typeof message === "object" && !Array.isArray(message);
  const id = objectMessage && hasOwn(message, "id") ? message.id : undefined;
  if (
    !objectMessage ||
    message.jsonrpc !== "2.0" ||
    typeof message.method !== "string"
  ) {
    writeMessage(jsonRpcError(id ?? null, -32600, "Invalid Request"));
    return;
  }

  if (message.method === "notifications/initialized") return;
  if (id === undefined) return;

  switch (message.method) {
    case "initialize": {
      let params;
      try {
        params = requireObject(message.params, "params");
      } catch (error) {
        writeMessage(jsonRpcError(id, -32602, error.message));
        return;
      }
      const requestedProtocol =
        typeof params.protocolVersion === "string" && params.protocolVersion !== ""
          ? params.protocolVersion
          : DEFAULT_PROTOCOL_VERSION;
      writeMessage(
        jsonRpcResult(id, {
          protocolVersion: requestedProtocol,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
          instructions: SERVER_INSTRUCTIONS,
        }),
      );
      return;
    }
    case "ping":
      writeMessage(jsonRpcResult(id, {}));
      return;
    case "tools/list":
      writeMessage(jsonRpcResult(id, { tools }));
      return;
    case "tools/call": {
      let params;
      try {
        params = requireObject(message.params, "params");
      } catch (error) {
        writeMessage(jsonRpcError(id, -32602, error.message));
        return;
      }
      if (typeof params.name !== "string" || !toolByName.has(params.name)) {
        writeMessage(jsonRpcError(id, -32602, "Unknown or missing tool name"));
        return;
      }
      const unknownParams = Object.keys(params).filter(
        (key) => !["name", "arguments", "_meta"].includes(key),
      );
      if (unknownParams.length > 0) {
        writeMessage(jsonRpcError(id, -32602, `Unsupported tool parameter: ${unknownParams.sort()[0]}`));
        return;
      }
      let cliArgs;
      try {
        cliArgs = cliArgumentsForTool(params.name, params.arguments);
      } catch (error) {
        if (error instanceof InvalidToolArguments) {
          writeMessage(jsonRpcError(id, -32602, error.message));
          return;
        }
        writeMessage(jsonRpcError(id, -32603, "Unable to prepare tool request"));
        return;
      }
      try {
        writeMessage(jsonRpcResult(id, toolResult(await runCli(cliArgs))));
      } catch (error) {
        writeMessage(jsonRpcResult(id, toolError(error)));
      }
      return;
    }
    default:
      writeMessage(jsonRpcError(id, -32601, "Method not found"));
  }
}

const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
let requestQueue = Promise.resolve();

input.on("line", (line) => {
  if (line.trim() === "") return;
  if (Buffer.byteLength(line) > MAX_LINE_BYTES) {
    writeMessage(jsonRpcError(null, -32700, "Request line is too large"));
    return;
  }
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    writeMessage(jsonRpcError(null, -32700, "Parse error"));
    return;
  }
  requestQueue = requestQueue
    .then(() => handleRequest(message))
    .catch(() => {
      const id = message && typeof message === "object" && hasOwn(message, "id") ? message.id : null;
      writeMessage(jsonRpcError(id, -32603, "Internal error"));
    });
});
