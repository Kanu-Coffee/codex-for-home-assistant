import { createHash } from "node:crypto";
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  statSync,
} from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

import {
  fetchHomeAssistantSnapshot,
  homeAssistantErrorCode,
  HomeAssistantUnavailableError,
} from "./ha-memory-ha-client.mjs";

export const DEFAULT_MEMORY_DB = "/data/codex-ha-memory/memory.sqlite3";
export const MEMORY_SCHEMA_VERSION = 1;
export const DEFAULT_SEARCH_LIMIT = 8;
export const MAX_SEARCH_LIMIT = 20;
export const MAX_SEARCH_BYTES = 32 * 1024;

const OBJECT_KINDS = new Set(["area", "device", "entity", "automation", "home"]);
const CATALOG_KINDS = new Set(["area", "device", "entity", "automation"]);
const MEMORY_TYPES = new Set([
  "alias",
  "purpose",
  "preference",
  "relationship",
  "note",
]);
const MEMORY_SOURCES = new Set([
  "user_explicit",
  "codex_change",
  "observation",
  "inference",
]);
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
const RESERVED_RELATIONSHIPS = new Set([
  "belongs_to",
  "located_in",
  "references",
]);
const SOURCE_AUTHORITY = {
  inference: 100,
  observation: 150,
  codex_change: 250,
  user_explicit: 300,
};
const STRUCTURAL_AUTHORITY = 1_000;
const CATALOG_FRESHNESS_MS = 24 * 60 * 60 * 1000;
const CANONICAL_CONFLICT_REASONS = new Set([
  "ha_subject_missing",
  "ha_canonical_mismatch",
  "ha_canonical_relationship_changed",
]);
const HA_AUTHORITY_CONFLICT_REASONS = new Set([
  ...CANONICAL_CONFLICT_REASONS,
  "change_expectation_mismatch",
]);

const AUDITED_TABLE_COLUMNS = {
  memory_items: [
    "id",
    "subject_kind",
    "subject_id",
    "memory_type",
    "memory_key",
    "value_json",
    "value_text",
    "source_kind",
    "source_ref",
    "authority",
    "status",
    "verification_method",
    "change_id",
    "supersedes_id",
    "created_at",
    "updated_at",
    "verified_at",
    "applied_at",
    "rejected_at",
  ],
  memory_evidence: [
    "id",
    "memory_id",
    "evidence_type",
    "detail",
    "evidence_hash",
    "created_at",
  ],
  conflicts: [
    "id",
    "subject_kind",
    "subject_id",
    "memory_type",
    "memory_key",
    "existing_memory_id",
    "candidate_memory_id",
    "reason",
    "ha_value_json",
    "status",
    "resolution",
    "created_at",
    "resolved_at",
  ],
  change_records: [
    "id",
    "summary",
    "subjects_json",
    "status",
    "before_sync_id",
    "after_sync_id",
    "expectation_hash",
    "expectation_summary_json",
    "verification_json",
    "created_at",
    "verified_at",
  ],
};

export class MemoryError extends Error {
  constructor(code, message, details = undefined) {
    super(message);
    this.name = "MemoryError";
    this.code = code;
    this.details = details;
  }
}

function nowIso() {
  if (process.env.HA_MEMORY_TEST_NOW) {
    const date = new Date(process.env.HA_MEMORY_TEST_NOW);
    if (!Number.isNaN(date.valueOf())) return date.toISOString();
  }
  return new Date().toISOString();
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, stableValue(value[key])]),
    );
  }
  return value;
}

export function stableJson(value) {
  return JSON.stringify(stableValue(value));
}

function hashText(value) {
  return createHash("sha256").update(value).digest("hex");
}

function isSecretLike(value) {
  if (typeof value !== "string" || !value) return false;
  for (const name of [
    "SUPERVISOR_TOKEN",
    "HA_BROWSER_TOKEN",
    "HOME_ASSISTANT_TOKEN",
    "HASS_TOKEN",
  ]) {
    const secret = process.env[name];
    if (typeof secret === "string" && secret.length >= 8 && value.includes(secret)) {
      return true;
    }
  }
  return [
    /-----BEGIN [A-Z ]*PRIVATE KEY-----/u,
    /\bSUPERVISOR_TOKEN\b/iu,
    /\bAuthorization\s*:\s*Bearer\s+\S+/iu,
    /["'](?:access_token|refresh_token|password|client_secret)["']\s*:/iu,
    /\b(?:access[_-]?token|api[_-]?key|password|client[_-]?secret)\s*[=:]\s*\S+/iu,
    /\b(?:access[_-]?token|api[_-]?key|password|client[_-]?secret)\s+(?:is|was)\s+\S+/iu,
    /https?:\/\/[^\s/@:]+:[^\s/@]+@/iu,
    /\bsk-(?:proj-)?[A-Za-z0-9_-]{16,}\b/u,
    /\b(?:sk|gh[opusr])_[A-Za-z0-9_-]{16,}\b/u,
    /\bAKIA[0-9A-Z]{16}\b/u,
    /\bAIza[0-9A-Za-z_-]{35}\b/u,
    /\bxox[baprs]-[0-9A-Za-z-]{10,}\b/u,
    /\beyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/u,
  ].some((pattern) => pattern.test(value));
}

function isPlainRecord(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isRawConversationLike(value) {
  return (
    /(?:^|\n)\s*(?:user|assistant|system|developer)\s*:/iu.test(value) ||
    /["']role["']\s*:\s*["'](?:user|assistant|system|developer)["']/iu.test(value) ||
    /<\|(?:im_start|im_end|user|assistant|system)\|>/iu.test(value) ||
    /(?:^|[\s{,])["']?(?:messages|conversation|transcript)["']?\s*:/iu.test(value)
  );
}

function durablePayloadViolation(value) {
  if (isSecretLike(value)) return "secret_rejected";
  if (
    /\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})\b/u.test(
      value,
    ) ||
    /["']?(?:last_changed|last_updated|current_state)["']?\s*[:=]/iu.test(value) ||
    /["']?state["']?\s*[:=]\s*(?:["'][^"']*["']|[^\s,;}]+)/iu.test(value) ||
    /\bstate\s+(?:is|was|becomes)\s+\S+/iu.test(value) ||
    /\b(?:currently|right now|at the moment)\b|(?:^|\s)(?:현재|지금)(?:\s|$)/iu.test(
      value,
    )
  ) {
    return "transient_rejected";
  }
  if (isRawConversationLike(value)) {
    return "conversation_rejected";
  }
  return null;
}

function safeText(value, maxLength = 500) {
  if (typeof value !== "string") return null;
  const normalized = value.replace(/[\u0000-\u001f\u007f]+/gu, " ").trim();
  if (!normalized || isSecretLike(normalized)) return null;
  return normalized.slice(0, maxLength);
}

function safeStringArray(value, maxItems = 50, maxLength = 200) {
  if (!Array.isArray(value)) return [];
  return [
    ...new Set(
      value
        .map((item) => safeText(item, maxLength))
        .filter((item) => item !== null),
    ),
  ].slice(0, maxItems);
}

function safeScalar(value, maxLength = 200) {
  if (typeof value === "string") return safeText(value, maxLength);
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "boolean") return value;
  return null;
}

function boundedUserText(value, maxLength, label) {
  if (typeof value !== "string" || value.length > maxLength) {
    throw new MemoryError(
      "invalid_text",
      `${label} must be a string of at most ${maxLength} characters`,
    );
  }
  const normalized = safeText(value, maxLength);
  if (!normalized) {
    throw new MemoryError("invalid_text", `${label} is empty or unsafe`);
  }
  return normalized;
}

function boundedDurableText(value, maxBytes, label, invalidCode = "invalid_text") {
  if (typeof value !== "string") {
    throw new MemoryError(invalidCode, `${label} must be a string`);
  }
  const normalized = value.replace(/[\u0000-\u001f\u007f]+/gu, " ").trim();
  if (!normalized || Buffer.byteLength(normalized, "utf8") > maxBytes) {
    throw new MemoryError(
      invalidCode,
      `${label} must contain at most ${maxBytes} UTF-8 bytes`,
    );
  }
  const violation = durablePayloadViolation(value);
  if (violation) {
    throw new MemoryError(violation, `${label} contains non-durable or unsafe data`);
  }
  return normalized;
}

function boundedSummaryText(value, maxBytes, label, invalidCode) {
  const normalized = boundedDurableText(value, maxBytes, label, invalidCode);
  if (
    /[\r\n\t]/u.test(value) ||
    normalized.split(/\s+/u).length > 40 ||
    !/^[\p{L}\p{N} .,_/@#():;!?+\-]+$/u.test(normalized)
  ) {
    throw new MemoryError(
      invalidCode,
      `${label} must be a concise single-line reference, not raw conversation`,
    );
  }
  return normalized;
}

function boundedEvidenceLabel(value, label, invalidCode) {
  const normalized = boundedDurableText(value, 200, label, invalidCode);
  if (!/^[a-z0-9][a-z0-9._:/@#()+\-]*$/u.test(normalized)) {
    throw new MemoryError(
      invalidCode,
      `${label} must be a lowercase identifier label without whitespace`,
    );
  }
  return normalized;
}

function ensureSafeUserPayload(value, label) {
  let serialized;
  try {
    serialized = stableJson(value);
  } catch {
    throw new MemoryError("invalid_json", `${label} must be JSON serializable`);
  }
  if (Buffer.byteLength(serialized, "utf8") > 4096) {
    throw new MemoryError("value_too_large", `${label} exceeds 4096 bytes`);
  }
  const violation = durablePayloadViolation(serialized);
  if (violation) {
    throw new MemoryError(violation, `${label} contains non-durable or unsafe data`);
  }
  return serialized;
}

function checkStorageObject(path, expectedType) {
  const info = lstatSync(path);
  if (info.isSymbolicLink()) {
    throw new MemoryError("unsafe_storage", `${path} must not be a symbolic link`);
  }
  if (expectedType === "directory" && !info.isDirectory()) {
    throw new MemoryError("unsafe_storage", `${path} must be a directory`);
  }
  if (expectedType === "file" && !info.isFile()) {
    throw new MemoryError("unsafe_storage", `${path} must be a regular file`);
  }
  if (expectedType === "file" && info.nlink !== 1) {
    throw new MemoryError("unsafe_storage", `${path} must not have multiple hard links`);
  }
  if (
    process.platform !== "win32" &&
    process.env.HA_MEMORY_TEST_MODE !== "1" &&
    info.uid !== 0
  ) {
    throw new MemoryError("unsafe_storage", `${path} must be owned by root`);
  }
  if (process.platform !== "win32") {
    const actualMode = info.mode & 0o777;
    const expectedMode = expectedType === "directory" ? 0o700 : 0o600;
    if (actualMode !== expectedMode) {
      throw new MemoryError(
        "unsafe_storage",
        `${path} must have mode ${expectedMode.toString(8).padStart(4, "0")}`,
      );
    }
  }
}

function lstatIfPresent(path) {
  try {
    return lstatSync(path);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

function prepareStorage(dbPath) {
  const directory = dirname(dbPath);
  if (!lstatIfPresent(directory)) mkdirSync(directory, { recursive: true, mode: 0o700 });
  checkStorageObject(directory, "directory");
  chmodSync(directory, 0o700);
  if (lstatIfPresent(dbPath)) {
    checkStorageObject(dbPath, "file");
    chmodSync(dbPath, 0o600);
  }
  for (const suffix of ["-wal", "-shm", "-journal"]) {
    const auxiliaryPath = `${dbPath}${suffix}`;
    if (lstatIfPresent(auxiliaryPath)) checkStorageObject(auxiliaryPath, "file");
  }
}

function secureSqliteFiles(dbPath) {
  for (const path of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
    if (!lstatIfPresent(path)) continue;
    checkStorageObject(path, "file");
    chmodSync(path, 0o600);
  }
}

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS metadata (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS sync_runs (
  id INTEGER PRIMARY KEY,
  status TEXT NOT NULL CHECK (status IN ('running', 'success', 'failed')),
  started_at TEXT NOT NULL,
  completed_at TEXT,
  ha_version TEXT,
  catalog_digest TEXT,
  object_count INTEGER NOT NULL DEFAULT 0,
  relation_count INTEGER NOT NULL DEFAULT 0,
  change_count INTEGER NOT NULL DEFAULT 0,
  warnings_json TEXT NOT NULL DEFAULT '[]',
  error_code TEXT
) STRICT;

CREATE TABLE IF NOT EXISTS catalog_objects (
  kind TEXT NOT NULL CHECK (kind IN ('area', 'device', 'entity', 'automation')),
  object_id TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  aliases_json TEXT NOT NULL,
  canonical_json TEXT NOT NULL,
  search_text TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  sync_id INTEGER NOT NULL REFERENCES sync_runs(id),
  active INTEGER NOT NULL CHECK (active IN (0, 1)),
  PRIMARY KEY (kind, object_id)
) STRICT;

CREATE TABLE IF NOT EXISTS catalog_relations (
  relation_key TEXT PRIMARY KEY,
  source_kind TEXT NOT NULL,
  source_id TEXT NOT NULL,
  relation TEXT NOT NULL,
  target_kind TEXT NOT NULL,
  target_id TEXT NOT NULL,
  metadata_json TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  sync_id INTEGER NOT NULL REFERENCES sync_runs(id),
  active INTEGER NOT NULL CHECK (active IN (0, 1))
) STRICT;

CREATE TABLE IF NOT EXISTS catalog_revisions (
  id INTEGER PRIMARY KEY,
  sync_id INTEGER NOT NULL REFERENCES sync_runs(id),
  subject_kind TEXT NOT NULL,
  subject_id TEXT NOT NULL,
  change_type TEXT NOT NULL CHECK (change_type IN ('created', 'updated', 'removed')),
  changed_fields_json TEXT NOT NULL,
  before_fingerprint TEXT,
  after_fingerprint TEXT,
  created_at TEXT NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS change_records (
  id INTEGER PRIMARY KEY,
  summary TEXT NOT NULL,
  subjects_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'verified', 'mismatch', 'unavailable')),
  before_sync_id INTEGER REFERENCES sync_runs(id),
  after_sync_id INTEGER REFERENCES sync_runs(id),
  expectation_hash TEXT NOT NULL,
  expectation_summary_json TEXT NOT NULL,
  verification_json TEXT,
  created_at TEXT NOT NULL,
  verified_at TEXT
) STRICT;

CREATE TABLE IF NOT EXISTS memory_items (
  id INTEGER PRIMARY KEY,
  subject_kind TEXT NOT NULL CHECK (subject_kind IN ('area', 'device', 'entity', 'automation', 'home')),
  subject_id TEXT NOT NULL,
  memory_type TEXT NOT NULL CHECK (memory_type IN ('alias', 'purpose', 'preference', 'relationship', 'note')),
  memory_key TEXT NOT NULL,
  value_json TEXT NOT NULL,
  value_text TEXT NOT NULL,
  source_kind TEXT NOT NULL CHECK (source_kind IN ('user_explicit', 'codex_change', 'observation', 'inference')),
  source_ref TEXT NOT NULL,
  authority INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'verified', 'applied', 'rejected', 'conflict', 'superseded')),
  verification_method TEXT,
  change_id INTEGER REFERENCES change_records(id),
  supersedes_id INTEGER REFERENCES memory_items(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  verified_at TEXT,
  applied_at TEXT,
  rejected_at TEXT
) STRICT;

CREATE UNIQUE INDEX IF NOT EXISTS memory_applied_slot
ON memory_items(subject_kind, subject_id, memory_type, memory_key)
WHERE status = 'applied';

CREATE INDEX IF NOT EXISTS memory_subject_status
ON memory_items(subject_kind, subject_id, status);

CREATE TABLE IF NOT EXISTS memory_evidence (
  id INTEGER PRIMARY KEY,
  memory_id INTEGER NOT NULL REFERENCES memory_items(id) ON DELETE CASCADE,
  evidence_type TEXT NOT NULL CHECK (evidence_type IN ('user_explicit', 'observation', 'ha_api', 'change_verification', 'manual_review')),
  detail TEXT NOT NULL,
  evidence_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(memory_id, evidence_type, evidence_hash)
) STRICT;

CREATE TABLE IF NOT EXISTS conflicts (
  id INTEGER PRIMARY KEY,
  subject_kind TEXT NOT NULL,
  subject_id TEXT NOT NULL,
  memory_type TEXT,
  memory_key TEXT,
  existing_memory_id INTEGER REFERENCES memory_items(id),
  candidate_memory_id INTEGER REFERENCES memory_items(id),
  reason TEXT NOT NULL,
  ha_value_json TEXT,
  status TEXT NOT NULL CHECK (status IN ('open', 'resolved')),
  resolution TEXT,
  created_at TEXT NOT NULL,
  resolved_at TEXT
) STRICT;

CREATE INDEX IF NOT EXISTS conflict_subject_status
ON conflicts(subject_kind, subject_id, status);

CREATE TABLE IF NOT EXISTS audit_events (
  id INTEGER PRIMARY KEY,
  action TEXT NOT NULL,
  actor TEXT NOT NULL,
  subject_key TEXT,
  summary TEXT NOT NULL,
  correlation_id TEXT,
  reversible INTEGER NOT NULL CHECK (reversible IN (0, 1)),
  rollback_of_event_id INTEGER REFERENCES audit_events(id),
  rolled_back_by_event_id INTEGER REFERENCES audit_events(id),
  created_at TEXT NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS audit_changes (
  event_id INTEGER NOT NULL REFERENCES audit_events(id) ON DELETE CASCADE,
  sequence INTEGER NOT NULL,
  table_name TEXT NOT NULL,
  row_key_json TEXT NOT NULL,
  before_json TEXT,
  after_json TEXT,
  PRIMARY KEY (event_id, sequence)
) STRICT;

CREATE VIRTUAL TABLE IF NOT EXISTS search_fts USING fts5(
  subject_key UNINDEXED,
  content,
  tokenize = 'unicode61 remove_diacritics 2'
);

CREATE INDEX IF NOT EXISTS catalog_object_active
ON catalog_objects(active, kind, object_id);

CREATE INDEX IF NOT EXISTS catalog_relation_source
ON catalog_relations(active, source_kind, source_id);

CREATE INDEX IF NOT EXISTS catalog_relation_target
ON catalog_relations(active, target_kind, target_id);

CREATE INDEX IF NOT EXISTS catalog_revision_subject
ON catalog_revisions(subject_kind, subject_id, id DESC);
`;

const REQUIRED_SCHEMA_COLUMNS = {
  metadata: ["key", "value"],
  sync_runs: [
    "id", "status", "started_at", "completed_at", "ha_version",
    "catalog_digest", "object_count", "relation_count", "change_count",
    "warnings_json", "error_code",
  ],
  catalog_objects: [
    "kind", "object_id", "name", "description", "aliases_json",
    "canonical_json", "search_text", "fingerprint", "first_seen_at",
    "last_seen_at", "sync_id", "active",
  ],
  catalog_relations: [
    "relation_key", "source_kind", "source_id", "relation", "target_kind",
    "target_id", "metadata_json", "fingerprint", "first_seen_at",
    "last_seen_at", "sync_id", "active",
  ],
  catalog_revisions: [
    "id", "sync_id", "subject_kind", "subject_id", "change_type",
    "changed_fields_json", "before_fingerprint", "after_fingerprint", "created_at",
  ],
  change_records: AUDITED_TABLE_COLUMNS.change_records,
  memory_items: AUDITED_TABLE_COLUMNS.memory_items,
  memory_evidence: AUDITED_TABLE_COLUMNS.memory_evidence,
  conflicts: AUDITED_TABLE_COLUMNS.conflicts,
  audit_events: [
    "id", "action", "actor", "subject_key", "summary", "correlation_id",
    "reversible", "rollback_of_event_id", "rolled_back_by_event_id", "created_at",
  ],
  audit_changes: [
    "event_id", "sequence", "table_name", "row_key_json", "before_json", "after_json",
  ],
  search_fts: ["subject_key", "content"],
};

const REQUIRED_SCHEMA_INDEXES = [
  "memory_applied_slot",
  "memory_subject_status",
  "conflict_subject_status",
  "catalog_object_active",
  "catalog_relation_source",
  "catalog_relation_target",
  "catalog_revision_subject",
];

function schemaObjects(db) {
  return db
    .prepare(
      `SELECT type, name, sql FROM sqlite_master
       WHERE substr(name, 1, 7) <> 'sqlite_'`,
    )
    .all()
    .filter((object) => !object.name.startsWith("search_fts_"));
}

function validateExistingSchema(db) {
  const objects = schemaObjects(db);
  const metadataObject = objects.find(
    (object) => object.type === "table" && object.name === "metadata",
  );
  if (!metadataObject) {
    if (objects.length === 0) return false;
    throw new MemoryError(
      "invalid_schema",
      "Memory database contains objects but no schema metadata",
    );
  }
  const versionRow = db
    .prepare("SELECT value FROM metadata WHERE key = 'schema_version'")
    .get();
  if (!versionRow) {
    throw new MemoryError(
      "invalid_schema",
      "Memory database metadata has no schema version",
    );
  }
  if (!/^[0-9]+$/u.test(versionRow.value)) {
    throw new MemoryError("unsupported_schema", "Memory schema version is invalid");
  }
  const version = Number(versionRow.value);
  if (version > MEMORY_SCHEMA_VERSION) {
    throw new MemoryError(
      "unsupported_schema",
      `Memory schema ${versionRow.value} is newer than this App supports`,
    );
  }
  if (version < MEMORY_SCHEMA_VERSION) {
    throw new MemoryError(
      "migration_required",
      `Memory schema ${version} requires an unavailable migration`,
    );
  }

  for (const [tableName, expectedColumns] of Object.entries(REQUIRED_SCHEMA_COLUMNS)) {
    const table = objects.find(
      (object) => object.type === "table" && object.name === tableName,
    );
    if (!table) {
      throw new MemoryError("invalid_schema", `Memory schema is missing ${tableName}`);
    }
    if (tableName === "search_fts" && !/\bUSING\s+fts5\b/iu.test(table.sql ?? "")) {
      throw new MemoryError("invalid_schema", "Memory search index is not FTS5");
    }
    const actualColumns = db
      .prepare(`PRAGMA table_info(${tableName})`)
      .all()
      .map((column) => column.name);
    if (stableJson(actualColumns) !== stableJson(expectedColumns)) {
      throw new MemoryError(
        "invalid_schema",
        `Memory schema columns for ${tableName} do not match version ${MEMORY_SCHEMA_VERSION}`,
      );
    }
  }
  for (const indexName of REQUIRED_SCHEMA_INDEXES) {
    if (!objects.some((object) => object.type === "index" && object.name === indexName)) {
      throw new MemoryError("invalid_schema", `Memory schema is missing ${indexName}`);
    }
  }
  const allowedObjects = new Set([
    ...Object.keys(REQUIRED_SCHEMA_COLUMNS),
    ...REQUIRED_SCHEMA_INDEXES,
  ]);
  const unexpected = objects.find((object) => !allowedObjects.has(object.name));
  if (unexpected) {
    throw new MemoryError(
      "invalid_schema",
      `Memory schema contains unexpected object ${unexpected.name}`,
    );
  }
  return true;
}

function assertDatabaseIntegrity(db) {
  const integrity = db.prepare("PRAGMA quick_check").get();
  if (!integrity || integrity.quick_check !== "ok") {
    throw new MemoryError(
      "database_corrupt",
      "Home Assistant memory database failed its integrity check",
    );
  }
}

function initializeSchema(db) {
  if (validateExistingSchema(db)) return;
  db.exec(SCHEMA_SQL);
  db.prepare(
    "INSERT INTO metadata(key, value) VALUES('schema_version', ?) ON CONFLICT(key) DO NOTHING",
  ).run(String(MEMORY_SCHEMA_VERSION));
  db.prepare(
    "INSERT INTO metadata(key, value) VALUES('catalog_status', 'empty') ON CONFLICT(key) DO NOTHING",
  ).run();
  validateExistingSchema(db);
}

export function openMemoryDatabase(dbPath = process.env.HA_MEMORY_DB ?? DEFAULT_MEMORY_DB) {
  process.umask(0o077);
  prepareStorage(dbPath);
  let db;
  try {
    const existingDatabase = lstatIfPresent(dbPath);
    if (existingDatabase && existingDatabase.size > 0) {
      let preflight;
      try {
        preflight = new DatabaseSync(dbPath, { readOnly: true });
        assertDatabaseIntegrity(preflight);
        validateExistingSchema(preflight);
      } catch (error) {
        if (error instanceof MemoryError) throw error;
        throw new MemoryError(
          "database_corrupt",
          "Home Assistant memory database could not be validated safely",
        );
      } finally {
        preflight?.close();
      }
    }
    db = new DatabaseSync(dbPath);
    db.exec("PRAGMA journal_mode = WAL");
    db.exec("PRAGMA synchronous = FULL");
    db.exec("PRAGMA foreign_keys = ON");
    db.exec("PRAGMA busy_timeout = 5000");
    db.exec("PRAGMA trusted_schema = OFF");
    db.exec("PRAGMA temp_store = MEMORY");
    assertDatabaseIntegrity(db);
    initializeSchema(db);
    assertDatabaseIntegrity(db);
    secureSqliteFiles(dbPath);
    return db;
  } catch (error) {
    db?.close();
    throw error;
  }
}

export function closeMemoryDatabase(db, dbPath = process.env.HA_MEMORY_DB ?? DEFAULT_MEMORY_DB) {
  db.close();
  secureSqliteFiles(dbPath);
}

export function parseSubject(subject) {
  if (typeof subject !== "string") {
    throw new MemoryError("invalid_subject", "A memory subject is required");
  }
  const normalized = subject.trim();
  let kind;
  let id;
  const separator = normalized.indexOf(":");
  if (separator > 0) {
    kind = normalized.slice(0, separator);
    id = normalized.slice(separator + 1);
  } else if (/^[a-z0-9_]+\.[a-z0-9_]+$/u.test(normalized)) {
    kind = "entity";
    id = normalized;
  }
  if (!OBJECT_KINDS.has(kind) || !id || id.length > 255) {
    throw new MemoryError(
      "invalid_subject",
      "Subject must be kind:id (area, device, entity, automation, or home)",
    );
  }
  if (!/^[A-Za-z0-9_.:-]+$/u.test(id)) {
    throw new MemoryError("invalid_subject", "Subject ID contains unsupported characters");
  }
  return { kind, id, key: `${kind}:${id}` };
}

function parsePositiveId(value, label) {
  const normalized =
    typeof value === "number" && Number.isSafeInteger(value) && value > 0
      ? value
      : typeof value === "string" && /^[1-9][0-9]*$/u.test(value)
        ? Number(value)
        : Number.NaN;
  if (!Number.isSafeInteger(normalized) || normalized <= 0) {
    throw new MemoryError("invalid_id", `${label} must be a positive integer`);
  }
  return normalized;
}

function boundedResultLimit(value, fallback, maximum) {
  const raw = value ?? fallback;
  const normalized =
    typeof raw === "number" && Number.isSafeInteger(raw)
      ? raw
      : typeof raw === "string" && /^[1-9][0-9]*$/u.test(raw)
        ? Number(raw)
        : Number.NaN;
  if (!Number.isSafeInteger(normalized) || normalized < 1) {
    throw new MemoryError("invalid_limit", "Result limit must be a positive integer");
  }
  return Math.min(maximum, normalized);
}

function canonicalObject(kind, objectId, name, description, aliases, canonical, at) {
  const safeName = safeText(name, 300) ?? objectId;
  const safeDescription = safeText(description, 1000);
  const safeAliases = safeStringArray(aliases);
  const canonicalJson = stableJson(canonical);
  const searchText = [
    kind,
    objectId,
    safeName,
    safeDescription,
    ...safeAliases,
    ...Object.values(canonical).filter((value) => typeof value === "string"),
  ]
    .filter(Boolean)
    .join(" ")
    .slice(0, 8000);
  const fingerprint = hashText(
    stableJson({
      kind,
      object_id: objectId,
      name: safeName,
      description: safeDescription,
      aliases: safeAliases,
      canonical,
    }),
  );
  return {
    kind,
    object_id: objectId,
    name: safeName,
    description: safeDescription,
    aliases_json: stableJson(safeAliases),
    canonical_json: canonicalJson,
    search_text: searchText,
    fingerprint,
    first_seen_at: at,
    last_seen_at: at,
    active: 1,
  };
}

function addRelation(relations, sourceKind, sourceId, relation, targetKind, targetId, metadata) {
  if (
    !CATALOG_KINDS.has(sourceKind) ||
    !CATALOG_KINDS.has(targetKind) ||
    !safeText(sourceId, 255) ||
    !safeText(targetId, 255)
  ) {
    return;
  }
  const relationKey = `${sourceKind}:${sourceId}|${relation}|${targetKind}:${targetId}`;
  const metadataJson = stableJson(metadata);
  relations.set(relationKey, {
    relation_key: relationKey,
    source_kind: sourceKind,
    source_id: sourceId,
    relation,
    target_kind: targetKind,
    target_id: targetId,
    metadata_json: metadataJson,
    fingerprint: hashText(metadataJson),
  });
}

function collectReferenceValues(value, keyName, output) {
  const stack = [value];
  let visited = 0;
  while (stack.length > 0 && visited < 50_000) {
    const current = stack.pop();
    visited += 1;
    if (!current || typeof current !== "object") continue;
    if (Array.isArray(current)) {
      for (const item of current) stack.push(item);
      continue;
    }
    for (const [key, child] of Object.entries(current)) {
      if (key === keyName) {
        const candidates = Array.isArray(child) ? child : [child];
        for (const candidate of candidates) {
          const safe = safeText(candidate, 255);
          if (safe) output.add(safe);
        }
      } else if (child && typeof child === "object") {
        stack.push(child);
      }
    }
  }
}

function normalizeAutomationReferences(detail) {
  const references = {
    area: new Set(),
    device: new Set(),
    entity: new Set(),
  };
  const relatedReferences = {
    area: new Set(),
    device: new Set(),
    entity: new Set(),
  };
  const related = detail?.related;
  if (related && typeof related === "object") {
    for (const [sourceKey, kind] of [
      ["area", "area"],
      ["areas", "area"],
      ["device", "device"],
      ["devices", "device"],
      ["entity", "entity"],
      ["entities", "entity"],
    ]) {
      const values = related[sourceKey];
      if (!Array.isArray(values)) continue;
      for (const value of values) {
        const safe = safeText(value, 255);
        if (safe) {
          references[kind].add(safe);
          relatedReferences[kind].add(safe);
        }
      }
    }
  }
  const config = detail?.config;
  if (config && typeof config === "object") {
    collectReferenceValues(config, "area_id", references.area);
    collectReferenceValues(config, "device_id", references.device);
    collectReferenceValues(config, "entity_id", references.entity);
  }
  return { references, relatedReferences };
}

function validateSnapshotIdentifier(value, label, entityLike = false) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    Buffer.byteLength(value, "utf8") > 255 ||
    isSecretLike(value) ||
    !(entityLike
      ? /^[a-z0-9_]+\.[A-Za-z0-9_.:-]+$/u.test(value)
      : /^[A-Za-z0-9_.:-]+$/u.test(value))
  ) {
    throw new MemoryError("invalid_snapshot", `${label} has an invalid identifier`);
  }
  return value;
}

function validateSnapshotList(rawSnapshot, key, idSelector, entityLike = false) {
  if (!Array.isArray(rawSnapshot[key])) {
    throw new MemoryError("invalid_snapshot", `Snapshot ${key} must be an array`);
  }
  const ids = new Set();
  for (const [index, item] of rawSnapshot[key].entries()) {
    if (!isPlainRecord(item)) {
      throw new MemoryError(
        "invalid_snapshot",
        `Snapshot ${key}[${index}] must be an object`,
      );
    }
    const id = validateSnapshotIdentifier(
      idSelector(item),
      `Snapshot ${key}[${index}]`,
      entityLike,
    );
    if (ids.has(id)) {
      throw new MemoryError("invalid_snapshot", `Snapshot ${key} contains duplicate ${id}`);
    }
    ids.add(id);
  }
}

function validateOptionalSnapshotStrings(item, fields, label) {
  for (const field of fields) {
    if (
      item[field] !== undefined &&
      item[field] !== null &&
      typeof item[field] !== "string"
    ) {
      throw new MemoryError(
        "invalid_snapshot",
        `${label}.${field} must be a string or null`,
      );
    }
  }
}

function validateOptionalSnapshotStringArrays(item, fields, label) {
  for (const field of fields) {
    if (
      item[field] !== undefined &&
      (!Array.isArray(item[field]) || item[field].some((value) => typeof value !== "string"))
    ) {
      throw new MemoryError(
        "invalid_snapshot",
        `${label}.${field} must be a string array`,
      );
    }
  }
}

function validateHomeAssistantSnapshot(rawSnapshot) {
  if (!isPlainRecord(rawSnapshot)) {
    throw new MemoryError("invalid_snapshot", "Home Assistant snapshot must be an object");
  }
  validateSnapshotList(rawSnapshot, "areas", (item) => item.area_id ?? item.id);
  validateSnapshotList(rawSnapshot, "devices", (item) => item.id);
  validateSnapshotList(rawSnapshot, "entities", (item) => item.entity_id, true);
  validateSnapshotList(rawSnapshot, "states", (item) => item.entity_id, true);
  for (const [index, area] of rawSnapshot.areas.entries()) {
    validateOptionalSnapshotStrings(
      area,
      ["name", "floor_id", "icon"],
      `Snapshot areas[${index}]`,
    );
    validateOptionalSnapshotStringArrays(
      area,
      ["aliases", "labels"],
      `Snapshot areas[${index}]`,
    );
  }
  for (const [index, device] of rawSnapshot.devices.entries()) {
    validateOptionalSnapshotStrings(
      device,
      ["name", "name_by_user", "area_id", "disabled_by", "manufacturer", "model"],
      `Snapshot devices[${index}]`,
    );
    validateOptionalSnapshotStringArrays(
      device,
      ["labels"],
      `Snapshot devices[${index}]`,
    );
  }
  for (const [index, entity] of rawSnapshot.entities.entries()) {
    validateOptionalSnapshotStrings(
      entity,
      [
        "name", "original_name", "area_id", "device_class", "device_id",
        "disabled_by", "entity_category", "hidden_by", "icon", "platform",
      ],
      `Snapshot entities[${index}]`,
    );
    validateOptionalSnapshotStringArrays(
      entity,
      ["aliases", "labels"],
      `Snapshot entities[${index}]`,
    );
  }
  for (const [index, state] of rawSnapshot.states.entries()) {
    if (typeof state.state !== "string") {
      throw new MemoryError(
        "invalid_snapshot",
        `Snapshot states[${index}].state must be a string`,
      );
    }
    if (state.attributes !== undefined && !isPlainRecord(state.attributes)) {
      throw new MemoryError(
        "invalid_snapshot",
        `Snapshot states[${index}].attributes must be an object`,
      );
    }
  }
  if (!isPlainRecord(rawSnapshot.automations)) {
    throw new MemoryError("invalid_snapshot", "Snapshot automations must be an object");
  }
  const expectedAutomationIds = new Set(
    [...rawSnapshot.states, ...rawSnapshot.entities]
      .map((item) => item.entity_id)
      .filter((entityId) => entityId.startsWith("automation.")),
  );
  const automationIds = new Set(Object.keys(rawSnapshot.automations));
  if (
    [...expectedAutomationIds].some((entityId) => !automationIds.has(entityId)) ||
    [...automationIds].some((entityId) => !expectedAutomationIds.has(entityId))
  ) {
    throw new MemoryError(
      "invalid_snapshot",
      "Snapshot automation details do not match automation states",
    );
  }
  for (const [entityId, detail] of Object.entries(rawSnapshot.automations)) {
    validateSnapshotIdentifier(entityId, "Snapshot automation key", true);
    if (!entityId.startsWith("automation.") || !isPlainRecord(detail)) {
      throw new MemoryError(
        "invalid_snapshot",
        `Snapshot automation ${entityId} is malformed`,
      );
    }
    for (const field of ["config", "related"]) {
      if (!isPlainRecord(detail[field])) {
        throw new MemoryError(
          "invalid_snapshot",
          `Snapshot automation ${entityId}.${field} must be an object`,
        );
      }
    }
  }
  if (!Array.isArray(rawSnapshot.warnings) || rawSnapshot.warnings.some(
    (warning) => typeof warning !== "string",
  )) {
    throw new MemoryError("invalid_snapshot", "Snapshot warnings must be a string array");
  }
  if (
    rawSnapshot.haVersion !== null &&
    rawSnapshot.haVersion !== undefined &&
    typeof rawSnapshot.haVersion !== "string"
  ) {
    throw new MemoryError("invalid_snapshot", "Snapshot HA version must be a string");
  }
}

export function normalizeHomeAssistantSnapshot(rawSnapshot) {
  validateHomeAssistantSnapshot(rawSnapshot);
  const at = nowIso();
  const objects = new Map();
  const relations = new Map();
  const stateById = new Map(
    rawSnapshot.states
      .filter((state) => state && typeof state.entity_id === "string")
      .map((state) => [state.entity_id, state]),
  );
  const entityRegistryById = new Map(
    rawSnapshot.entities.map((entity) => [entity.entity_id, entity]),
  );
  const deviceById = new Map(
    rawSnapshot.devices
      .filter((device) => device && typeof device.id === "string")
      .map((device) => [device.id, device]),
  );

  for (const area of rawSnapshot.areas) {
    const id = safeText(area?.area_id ?? area?.id, 255);
    if (!id) continue;
    const canonical = {
      floor_id: safeScalar(area.floor_id),
      icon: safeScalar(area.icon),
      labels: safeStringArray(area.labels),
    };
    const object = canonicalObject(
      "area",
      id,
      area.name,
      null,
      area.aliases,
      canonical,
      at,
    );
    objects.set(`area:${id}`, object);
  }

  for (const device of rawSnapshot.devices) {
    const id = safeText(device?.id, 255);
    if (!id) continue;
    const areaId = safeText(device.area_id, 255);
    const canonical = {
      area_id: areaId,
      disabled_by: safeScalar(device.disabled_by),
      labels: safeStringArray(device.labels),
      manufacturer: safeScalar(device.manufacturer),
      model: safeScalar(device.model),
    };
    const object = canonicalObject(
      "device",
      id,
      device.name_by_user ?? device.name,
      [safeText(device.manufacturer), safeText(device.model)].filter(Boolean).join(" "),
      [],
      canonical,
      at,
    );
    objects.set(`device:${id}`, object);
    if (areaId) {
      addRelation(relations, "device", id, "located_in", "area", areaId, {
        source: "device_registry",
      });
    }
  }

  const registeredEntityIds = new Set();
  for (const entity of rawSnapshot.entities) {
    const id = safeText(entity?.entity_id, 255);
    if (!id) continue;
    registeredEntityIds.add(id);
    const state = stateById.get(id);
    const deviceId = safeText(entity.device_id, 255);
    const directAreaId = safeText(entity.area_id, 255);
    const inheritedAreaId = deviceId
      ? safeText(deviceById.get(deviceId)?.area_id, 255)
      : null;
    const areaId = directAreaId ?? inheritedAreaId;
    const canonical = {
      area_id: areaId,
      area_source: directAreaId ? "entity" : inheritedAreaId ? "device" : null,
      device_class: safeScalar(entity.device_class),
      device_id: deviceId,
      disabled_by: safeScalar(entity.disabled_by),
      entity_category: safeScalar(entity.entity_category),
      hidden_by: safeScalar(entity.hidden_by),
      icon: safeScalar(entity.icon),
      labels: safeStringArray(entity.labels),
      platform: safeScalar(entity.platform),
    };
    const object = canonicalObject(
      "entity",
      id,
      entity.name ?? entity.original_name ?? state?.attributes?.friendly_name,
      null,
      entity.aliases,
      canonical,
      at,
    );
    objects.set(`entity:${id}`, object);
    if (deviceId) {
      addRelation(relations, "entity", id, "belongs_to", "device", deviceId, {
        source: "entity_registry",
      });
    }
    if (areaId) {
      addRelation(relations, "entity", id, "located_in", "area", areaId, {
        source: directAreaId ? "entity_registry" : "device_registry_inherited",
      });
    }
  }

  for (const state of rawSnapshot.states) {
    const id = safeText(state?.entity_id, 255);
    if (!id || registeredEntityIds.has(id)) continue;
    const canonical = {
      area_id: null,
      area_source: null,
      device_class: safeScalar(state.attributes?.device_class),
      device_id: null,
      disabled_by: null,
      entity_category: null,
      hidden_by: null,
      icon: safeScalar(state.attributes?.icon),
      labels: [],
      platform: null,
    };
    objects.set(
      `entity:${id}`,
      canonicalObject(
        "entity",
        id,
        state.attributes?.friendly_name,
        null,
        [],
        canonical,
        at,
      ),
    );
  }

  const automationEntityIds = [
    ...new Set(
      [...stateById.keys(), ...entityRegistryById.keys()].filter((entityId) =>
        entityId.startsWith("automation."),
      ),
    ),
  ].sort();
  for (const entityId of automationEntityIds) {
    const state = stateById.get(entityId);
    const registryEntry = entityRegistryById.get(entityId);
    const detail = rawSnapshot.automations?.[entityId] ?? {};
    const config = detail.config && typeof detail.config === "object" ? detail.config : {};
    const canonical = {
      automation_id: safeScalar(config.id ?? state?.attributes?.id),
      mode: safeScalar(config.mode ?? state?.attributes?.mode),
    };
    objects.set(
      `automation:${entityId}`,
      canonicalObject(
        "automation",
        entityId,
        config.alias ??
          state?.attributes?.friendly_name ??
          registryEntry?.name ??
          registryEntry?.original_name,
        config.description,
        [],
        canonical,
        at,
      ),
    );
    const { references, relatedReferences } = normalizeAutomationReferences(detail);
    for (const [kind, values] of Object.entries(references)) {
      for (const targetId of values) {
        addRelation(
          relations,
          "automation",
          entityId,
          "references",
          kind,
          targetId,
          {
            source: relatedReferences[kind].has(targetId)
              ? "search_related"
              : "automation_config",
          },
        );
      }
    }
  }

  const digest = hashText(
    stableJson({
      objects: [...objects.values()].map((object) => object.fingerprint).sort(),
    relations: [...relations.values()]
      .map((relation) => `${relation.relation_key}:${relation.fingerprint}`)
      .sort(),
    }),
  );
  return {
    at,
    haVersion: safeText(rawSnapshot.haVersion, 100),
    objects,
    relations,
    digest,
    warnings: safeStringArray(rawSnapshot.warnings, 100, 300),
  };
}

function rowsByKey(rows, key) {
  return new Map(rows.map((row) => [row[key], row]));
}

function changedObjectFields(before, after) {
  const fields = [];
  for (const field of ["name", "description", "aliases_json", "canonical_json"]) {
    if (before[field] !== after[field]) fields.push(field.replace(/_json$/u, ""));
  }
  return fields;
}

function metadataSet(db, key, value) {
  db.prepare(
    "INSERT INTO metadata(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
  ).run(key, String(value));
}

function metadataGet(db, key) {
  return db.prepare("SELECT value FROM metadata WHERE key = ?").get(key)?.value ?? null;
}

function latestSuccessfulSyncId(db) {
  return (
    db
      .prepare("SELECT id FROM sync_runs WHERE status = 'success' ORDER BY id DESC LIMIT 1")
      .get()?.id ?? null
  );
}

function runTransaction(db, callback) {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = callback();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function subjectExists(db, subject, activeOnly = true) {
  if (subject.kind === "home") return true;
  const suffix = activeOnly ? " AND active = 1" : "";
  return Boolean(
    db
      .prepare(
        `SELECT 1 AS found FROM catalog_objects WHERE kind = ? AND object_id = ?${suffix}`,
      )
      .get(subject.kind, subject.id),
  );
}

function requireSubjectExists(db, subject) {
  if (!subjectExists(db, subject)) {
    throw new MemoryError(
      "subject_not_found",
      `Memory subject ${subject.key} is not active in the latest Home Assistant catalog`,
    );
  }
}

function relationRowKey(row) {
  return row.relation_key;
}

function insertCatalogRevision(
  db,
  syncId,
  subjectKind,
  subjectId,
  changeType,
  changedFields,
  beforeFingerprint,
  afterFingerprint,
  at,
) {
  db.prepare(
    `INSERT INTO catalog_revisions(
      sync_id, subject_kind, subject_id, change_type, changed_fields_json,
      before_fingerprint, after_fingerprint, created_at
    ) VALUES(?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    syncId,
    subjectKind,
    subjectId,
    changeType,
    stableJson(changedFields),
    beforeFingerprint,
    afterFingerprint,
    at,
  );
}

function insertAuditEvent(
  db,
  {
    action,
    actor,
    subjectKey = null,
    summary,
    correlationId = null,
    reversible = true,
    rollbackOfEventId = null,
  },
) {
  const safeSummary = safeText(summary, 500);
  if (!safeSummary) {
    throw new MemoryError("invalid_summary", "Audit summary is empty or unsafe");
  }
  return Number(
    db
      .prepare(
        `INSERT INTO audit_events(
          action, actor, subject_key, summary, correlation_id, reversible,
          rollback_of_event_id, created_at
        ) VALUES(?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        action,
        actor,
        subjectKey,
        safeSummary,
        correlationId,
        reversible ? 1 : 0,
        rollbackOfEventId,
        nowIso(),
      ).lastInsertRowid,
  );
}

function primaryKeyForTable(tableName, rowOrId) {
  if (!Object.hasOwn(AUDITED_TABLE_COLUMNS, tableName)) {
    throw new MemoryError("audit_table_rejected", `Table ${tableName} cannot be audited`);
  }
  const id = typeof rowOrId === "object" ? rowOrId?.id : rowOrId;
  if (!Number.isInteger(Number(id))) {
    throw new MemoryError("audit_key_invalid", `Table ${tableName} requires an integer ID`);
  }
  return { id: Number(id) };
}

function readAuditedRow(db, tableName, rowOrId) {
  const key = primaryKeyForTable(tableName, rowOrId);
  return db.prepare(`SELECT * FROM ${tableName} WHERE id = ?`).get(key.id) ?? null;
}

function recordAuditChange(db, eventId, sequence, tableName, rowOrId, before, after) {
  const key = primaryKeyForTable(tableName, rowOrId);
  db.prepare(
    `INSERT INTO audit_changes(
      event_id, sequence, table_name, row_key_json, before_json, after_json
    ) VALUES(?, ?, ?, ?, ?, ?)`,
  ).run(
    eventId,
    sequence,
    tableName,
    stableJson(key),
    before === null ? null : stableJson(before),
    after === null ? null : stableJson(after),
  );
}

function rebuildSearchSubject(db, subjectKind, subjectId) {
  const subjectKey = `${subjectKind}:${subjectId}`;
  db.prepare("DELETE FROM search_fts WHERE subject_key = ?").run(subjectKey);
  const object =
    subjectKind === "home"
      ? null
      : db
          .prepare(
            `SELECT * FROM catalog_objects
             WHERE kind = ? AND object_id = ? AND active = 1`,
          )
          .get(subjectKind, subjectId);
  if (subjectKind !== "home" && !object) return;
  const memories = db
    .prepare(
      `SELECT memory_type, memory_key, value_text
       FROM memory_items AS memory
       WHERE subject_kind = ? AND subject_id = ? AND status = 'applied'
         AND NOT EXISTS (
           SELECT 1 FROM conflicts
           WHERE status = 'open' AND (
             existing_memory_id = memory.id OR candidate_memory_id = memory.id
           )
         )
       ORDER BY id`,
    )
    .all(subjectKind, subjectId);
  if (!object && memories.length === 0) return;
  const content = [
    subjectKey,
    object?.object_id,
    object?.name,
    object?.description,
    object?.search_text,
    ...memories.flatMap((memory) => [
      memory.memory_type,
      memory.memory_key,
      memory.value_text,
    ]),
  ]
    .filter(Boolean)
    .join(" ")
    .slice(0, 16_000);
  db.prepare("INSERT INTO search_fts(subject_key, content) VALUES(?, ?)").run(
    subjectKey,
    content,
  );
}

function rebuildAllSearch(db) {
  db.exec("DELETE FROM search_fts");
  const subjects = db
    .prepare(
      `SELECT kind AS subject_kind, object_id AS subject_id
       FROM catalog_objects WHERE active = 1
       UNION
       SELECT subject_kind, subject_id FROM memory_items
       WHERE subject_kind = 'home' AND status = 'applied'`,
    )
    .all();
  for (const subject of subjects) {
    rebuildSearchSubject(db, subject.subject_kind, subject.subject_id);
  }
}

function openConflict(
  db,
  {
    subjectKind,
    subjectId,
    memoryType = null,
    memoryKey = null,
    existingMemoryId = null,
    candidateMemoryId = null,
    reason,
    haValue = null,
  },
  audit = null,
) {
  const existing = db
    .prepare(
      `SELECT * FROM conflicts
       WHERE subject_kind = ? AND subject_id = ?
         AND ifnull(memory_type, '') = ifnull(?, '')
         AND ifnull(memory_key, '') = ifnull(?, '')
         AND ifnull(existing_memory_id, -1) = ifnull(?, -1)
         AND ifnull(candidate_memory_id, -1) = ifnull(?, -1)
         AND reason = ? AND status = 'open'
       ORDER BY id DESC LIMIT 1`,
    )
    .get(
      subjectKind,
      subjectId,
      memoryType,
      memoryKey,
      existingMemoryId,
      candidateMemoryId,
      reason,
    );
  if (existing) return existing;
  let effectiveAudit = audit;
  if (!effectiveAudit) {
    const eventId = insertAuditEvent(db, {
      action: "catalog_conflict_opened",
      actor: "ha_api",
      subjectKey: `${subjectKind}:${subjectId}`,
      summary: `Home Assistant catalog opened ${reason} conflict`,
      correlationId: latestSuccessfulSyncId(db)
        ? `sync:${latestSuccessfulSyncId(db)}`
        : null,
      reversible: false,
    });
    effectiveAudit = createAuditRecorder(db, eventId);
  }
  const haValueJson =
    haValue === null ? null : ensureSafeUserPayload(haValue, "HA conflict value");
  const result = db
    .prepare(
      `INSERT INTO conflicts(
        subject_kind, subject_id, memory_type, memory_key,
        existing_memory_id, candidate_memory_id, reason, ha_value_json,
        status, created_at
      ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, 'open', ?)`,
    )
    .run(
      subjectKind,
      subjectId,
      memoryType,
      memoryKey,
      existingMemoryId,
      candidateMemoryId,
      reason,
      haValueJson,
      nowIso(),
    );
  const row = readAuditedRow(db, "conflicts", Number(result.lastInsertRowid));
  if (effectiveAudit) {
    recordAuditChange(
      db,
      effectiveAudit.eventId,
      effectiveAudit.nextSequence(),
      "conflicts",
      row,
      null,
      row,
    );
  }
  return row;
}

function resolveCatalogConflict(db, conflict, resolution, at) {
  const eventId = insertAuditEvent(db, {
    action: "catalog_conflict_resolved",
    actor: "ha_api",
    subjectKey: `${conflict.subject_kind}:${conflict.subject_id}`,
    summary: `Home Assistant catalog resolved ${conflict.reason} conflict`,
    correlationId: latestSuccessfulSyncId(db)
      ? `sync:${latestSuccessfulSyncId(db)}`
      : null,
    reversible: false,
  });
  const audit = createAuditRecorder(db, eventId);
  const before = readAuditedRow(db, "conflicts", conflict.id);
  db.prepare(
    `UPDATE conflicts SET status = 'resolved', resolution = ?, resolved_at = ?
     WHERE id = ? AND status = 'open'`,
  ).run(resolution, at, conflict.id);
  audit.updated("conflicts", conflict.id, before);
}

function resolveCatalogConflicts(db, at) {
  const applied = db
    .prepare("SELECT * FROM memory_items WHERE status = 'applied'")
    .all();
  for (const memory of applied) {
    const subject = {
      kind: memory.subject_kind,
      id: memory.subject_id,
      key: `${memory.subject_kind}:${memory.subject_id}`,
    };
    if (subject.kind !== "home" && !subjectExists(db, subject)) {
      openConflict(db, {
        subjectKind: subject.kind,
        subjectId: subject.id,
        memoryType: memory.memory_type,
        memoryKey: memory.memory_key,
        existingMemoryId: memory.id,
        reason: "ha_subject_missing",
        haValue: { exists: false },
      });
      continue;
    }

    const restoredSubjectConflicts = db
      .prepare(
        `SELECT * FROM conflicts
         WHERE existing_memory_id = ? AND reason = 'ha_subject_missing'
           AND status = 'open'`,
      )
      .all(memory.id);
    for (const conflict of restoredSubjectConflicts) {
      resolveCatalogConflict(db, conflict, "ha_subject_restored", at);
    }

    if (memory.memory_type !== "relationship") continue;
    let value;
    try {
      value = JSON.parse(memory.value_json);
    } catch {
      continue;
    }
    const relation = safeText(value?.relation, 80);
    const target = parseRelationshipTarget(value);
    if (!relation || !target || !RESERVED_RELATIONSHIPS.has(relation)) continue;
    const matches = db
      .prepare(
        `SELECT 1 AS found FROM catalog_relations
         WHERE source_kind = ? AND source_id = ? AND relation = ?
           AND target_kind = ? AND target_id = ? AND active = 1`,
      )
      .get(subject.kind, subject.id, relation, target.kind, target.id);
    if (!matches) {
      openConflict(db, {
        subjectKind: subject.kind,
        subjectId: subject.id,
        memoryType: memory.memory_type,
        memoryKey: memory.memory_key,
        existingMemoryId: memory.id,
        reason: "ha_canonical_relationship_changed",
        haValue: { relation, matches: false },
      });
    } else {
      const restoredRelationshipConflicts = db
        .prepare(
          `SELECT * FROM conflicts
           WHERE existing_memory_id = ?
             AND reason = 'ha_canonical_relationship_changed' AND status = 'open'`,
        )
        .all(memory.id);
      for (const conflict of restoredRelationshipConflicts) {
        resolveCatalogConflict(db, conflict, "ha_relationship_restored", at);
      }
    }
  }
}

function applyNormalizedSnapshot(db, syncId, snapshot) {
  return runTransaction(db, () => {
    const newerSuccessfulSync = db
      .prepare(
        "SELECT id FROM sync_runs WHERE status = 'success' AND id > ? ORDER BY id DESC LIMIT 1",
      )
      .get(syncId);
    if (newerSuccessfulSync) {
      db.prepare(
        `UPDATE sync_runs SET status = 'failed', completed_at = ?,
          error_code = 'superseded_refresh' WHERE id = ?`,
      ).run(nowIso(), syncId);
      return {
        sync_id: syncId,
        status: "skipped",
        reason: "newer_refresh_already_applied",
        superseded_by_sync_id: newerSuccessfulSync.id,
      };
    }
    const existingObjects = new Map();
    for (const row of db.prepare("SELECT * FROM catalog_objects WHERE active = 1").all()) {
      existingObjects.set(`${row.kind}:${row.object_id}`, row);
    }
    const existingRelations = rowsByKey(
      db.prepare("SELECT * FROM catalog_relations WHERE active = 1").all(),
      "relation_key",
    );
    let changeCount = 0;

    db.exec("UPDATE catalog_objects SET active = 0 WHERE active = 1");
    const objectUpsert = db.prepare(
      `INSERT INTO catalog_objects(
        kind, object_id, name, description, aliases_json, canonical_json,
        search_text, fingerprint, first_seen_at, last_seen_at, sync_id, active
      ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
      ON CONFLICT(kind, object_id) DO UPDATE SET
        name = excluded.name,
        description = excluded.description,
        aliases_json = excluded.aliases_json,
        canonical_json = excluded.canonical_json,
        search_text = excluded.search_text,
        fingerprint = excluded.fingerprint,
        last_seen_at = excluded.last_seen_at,
        sync_id = excluded.sync_id,
        active = 1`,
    );
    for (const [key, object] of snapshot.objects.entries()) {
      const before = existingObjects.get(key);
      objectUpsert.run(
        object.kind,
        object.object_id,
        object.name,
        object.description,
        object.aliases_json,
        object.canonical_json,
        object.search_text,
        object.fingerprint,
        before?.first_seen_at ?? object.first_seen_at,
        object.last_seen_at,
        syncId,
      );
      if (!before) {
        insertCatalogRevision(
          db,
          syncId,
          object.kind,
          object.object_id,
          "created",
          ["catalog"],
          null,
          object.fingerprint,
          snapshot.at,
        );
        changeCount += 1;
      } else if (before.fingerprint !== object.fingerprint) {
        insertCatalogRevision(
          db,
          syncId,
          object.kind,
          object.object_id,
          "updated",
          changedObjectFields(before, object),
          before.fingerprint,
          object.fingerprint,
          snapshot.at,
        );
        changeCount += 1;
      }
    }
    for (const [key, before] of existingObjects.entries()) {
      if (snapshot.objects.has(key)) continue;
      insertCatalogRevision(
        db,
        syncId,
        before.kind,
        before.object_id,
        "removed",
        ["active"],
        before.fingerprint,
        null,
        snapshot.at,
      );
      changeCount += 1;
    }

    db.exec("UPDATE catalog_relations SET active = 0 WHERE active = 1");
    const relationUpsert = db.prepare(
      `INSERT INTO catalog_relations(
        relation_key, source_kind, source_id, relation, target_kind, target_id,
        metadata_json, fingerprint, first_seen_at, last_seen_at, sync_id, active
      ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
      ON CONFLICT(relation_key) DO UPDATE SET
        metadata_json = excluded.metadata_json,
        fingerprint = excluded.fingerprint,
        last_seen_at = excluded.last_seen_at,
        sync_id = excluded.sync_id,
        active = 1`,
    );
    for (const [key, relation] of snapshot.relations.entries()) {
      const before = existingRelations.get(key);
      relationUpsert.run(
        relation.relation_key,
        relation.source_kind,
        relation.source_id,
        relation.relation,
        relation.target_kind,
        relation.target_id,
        relation.metadata_json,
        relation.fingerprint,
        before?.first_seen_at ?? snapshot.at,
        snapshot.at,
        syncId,
      );
      if (!before || before.fingerprint !== relation.fingerprint) {
        insertCatalogRevision(
          db,
          syncId,
          relation.source_kind,
          relation.source_id,
          before ? "updated" : "created",
          [`relationship:${relation.relation}:${relation.target_kind}:${relation.target_id}`],
          before?.fingerprint ?? null,
          relation.fingerprint,
          snapshot.at,
        );
        changeCount += 1;
      }
    }
    for (const [key, before] of existingRelations.entries()) {
      if (snapshot.relations.has(key)) continue;
      insertCatalogRevision(
        db,
        syncId,
        before.source_kind,
        before.source_id,
        "removed",
        [`relationship:${before.relation}:${before.target_kind}:${before.target_id}`],
        before.fingerprint,
        null,
        snapshot.at,
      );
      changeCount += 1;
    }

    db.prepare(
      `UPDATE sync_runs SET
        status = 'success', completed_at = ?, ha_version = ?, catalog_digest = ?,
        object_count = ?, relation_count = ?, change_count = ?, warnings_json = ?
       WHERE id = ?`,
    ).run(
      snapshot.at,
      snapshot.haVersion,
      snapshot.digest,
      snapshot.objects.size,
      snapshot.relations.size,
      changeCount,
      stableJson(snapshot.warnings),
      syncId,
    );
    metadataSet(db, "catalog_status", "ready");
    metadataSet(db, "last_successful_sync_at", snapshot.at);
    metadataSet(db, "last_successful_sync_id", syncId);
    resolveCatalogConflicts(db, snapshot.at);
    if (changeCount > 0) rebuildAllSearch(db);
    if (changeCount > 0) {
      insertAuditEvent(db, {
        action: "catalog_sync",
        actor: "ha_api",
        summary: `Refreshed ${snapshot.objects.size} Home Assistant objects and ${snapshot.relations.size} relationships`,
        correlationId: `sync:${syncId}`,
        reversible: false,
      });
    }
    return {
      sync_id: syncId,
      status: "success",
      catalog_digest: snapshot.digest,
      object_count: snapshot.objects.size,
      relation_count: snapshot.relations.size,
      change_count: changeCount,
      warnings: snapshot.warnings,
    };
  });
}

function beginSync(db) {
  return Number(
    db
      .prepare("INSERT INTO sync_runs(status, started_at) VALUES('running', ?)")
      .run(nowIso()).lastInsertRowid,
  );
}

function failSync(db, syncId, error) {
  const errorCode =
    error instanceof HomeAssistantUnavailableError
      ? homeAssistantErrorCode(error)
      : error instanceof MemoryError
        ? error.code
        : "refresh_failed";
  runTransaction(db, () => {
    db.prepare(
      `UPDATE sync_runs
       SET status = 'failed', completed_at = ?, error_code = ?
       WHERE id = ? AND status = 'running'`,
    ).run(nowIso(), errorCode, syncId);
    const latestSuccess = latestSuccessfulSyncId(db);
    if (latestSuccess && latestSuccess > syncId) {
      metadataSet(db, "catalog_status", "ready");
      return;
    }
    metadataSet(db, "catalog_status", latestSuccess ? "stale" : "degraded");
  });
}

export async function refreshMemory(db, options = {}) {
  const ifStaleSeconds = options.ifStaleSeconds ?? null;
  if (ifStaleSeconds !== null && !options.force && !options.rawSnapshot) {
    const last = metadataGet(db, "last_successful_sync_at");
    if (last && metadataGet(db, "catalog_status") === "ready") {
      const ageMs = new Date(nowIso()).valueOf() - new Date(last).valueOf();
      if (Number.isFinite(ageMs) && ageMs < ifStaleSeconds * 1000) {
        return {
          status: "skipped",
          reason: "catalog_fresh",
          sync_id: latestSuccessfulSyncId(db),
          last_successful_sync_at: last,
        };
      }
    }
  }

  const syncId = beginSync(db);
  try {
    const rawSnapshot = options.rawSnapshot !== undefined && options.rawSnapshot !== null
      ? await options.rawSnapshot
      : await fetchHomeAssistantSnapshot({
          fixturePath: options.fixturePath,
          timeoutMs: options.timeoutMs,
        });
    const normalized = normalizeHomeAssistantSnapshot(rawSnapshot);
    const result = applyNormalizedSnapshot(db, syncId, normalized);
    return {
      ...result,
      raw_snapshot: options.returnRaw ? rawSnapshot : undefined,
      normalized_snapshot: options.returnNormalized ? normalized : undefined,
    };
  } catch (error) {
    failSync(db, syncId, error);
    throw error;
  }
}

function ftsExpression(query) {
  const tokens = query
    .normalize("NFKC")
    .toLocaleLowerCase()
    .split(/[^\p{L}\p{N}_]+/u)
    .filter(Boolean)
    .slice(0, 12);
  if (tokens.length === 0) {
    throw new MemoryError("invalid_query", "Search query has no searchable terms");
  }
  return tokens.map((token) => `"${token.replaceAll('"', '""')}"*`).join(" OR ");
}

function parseJsonColumn(value, fallback) {
  try {
    return value === null ? fallback : JSON.parse(value);
  } catch {
    return fallback;
  }
}

function catalogFreshness(db) {
  const storedStatus = metadataGet(db, "catalog_status") ?? "empty";
  const verifiedAt = metadataGet(db, "last_successful_sync_at");
  const timestamp = verifiedAt ? new Date(verifiedAt).valueOf() : Number.NaN;
  const currentTime = new Date(nowIso()).valueOf();
  const ageMs = Number.isFinite(timestamp) && Number.isFinite(currentTime)
    ? Math.max(0, currentTime - timestamp)
    : null;
  const fresh = storedStatus === "ready" && ageMs !== null && ageMs <= CATALOG_FRESHNESS_MS;
  return {
    stored_status: storedStatus,
    status: storedStatus === "ready" && !fresh ? "stale" : storedStatus,
    verified_at: verifiedAt,
    age_seconds: ageMs === null ? null : Math.floor(ageMs / 1000),
    fresh,
  };
}

function subjectContext(db, subject, relationLimit = 12) {
  const canonical =
    subject.kind === "home"
      ? null
      : db
          .prepare(
            `SELECT kind, object_id, name, description, aliases_json, canonical_json,
                    last_seen_at, sync_id, active
             FROM catalog_objects WHERE kind = ? AND object_id = ?`,
          )
          .get(subject.kind, subject.id);
  if (subject.kind !== "home" && (!canonical || canonical.active !== 1)) return null;
  const memories = db
    .prepare(
      `SELECT id, memory_type, memory_key, value_json, source_kind,
              verification_method, verified_at, applied_at
       FROM memory_items AS memory
       WHERE subject_kind = ? AND subject_id = ? AND status = 'applied'
         AND NOT EXISTS (
           SELECT 1 FROM conflicts
           WHERE status = 'open' AND (
             existing_memory_id = memory.id OR candidate_memory_id = memory.id
           )
         )
       ORDER BY authority DESC, id DESC LIMIT 20`,
    )
    .all(subject.kind, subject.id)
    .map((memory) => ({
      id: memory.id,
      type: memory.memory_type,
      key: memory.memory_key,
      value: parseJsonColumn(memory.value_json, null),
      source: memory.source_kind,
      verification: memory.verification_method,
      verified_at: memory.verified_at,
      applied_at: memory.applied_at,
    }));
  const outgoing = db
    .prepare(
      `SELECT relation, target_kind, target_id, metadata_json
       FROM catalog_relations
       WHERE source_kind = ? AND source_id = ? AND active = 1
       ORDER BY relation, target_kind, target_id LIMIT ?`,
    )
    .all(subject.kind, subject.id, relationLimit)
    .map((relation) => ({
      relation: relation.relation,
      target: `${relation.target_kind}:${relation.target_id}`,
      source: parseJsonColumn(relation.metadata_json, {}).source ?? "ha_api",
    }));
  const incoming = db
    .prepare(
      `SELECT source_kind, source_id, relation, metadata_json
       FROM catalog_relations
       WHERE target_kind = ? AND target_id = ? AND active = 1
       ORDER BY relation, source_kind, source_id LIMIT ?`,
    )
    .all(subject.kind, subject.id, relationLimit)
    .map((relation) => ({
      source_subject: `${relation.source_kind}:${relation.source_id}`,
      relation: relation.relation,
      source: parseJsonColumn(relation.metadata_json, {}).source ?? "ha_api",
    }));
  const conflicts = db
    .prepare(
      `SELECT id, memory_type, memory_key, reason, created_at
       FROM conflicts
       WHERE subject_kind = ? AND subject_id = ? AND status = 'open'
       ORDER BY id DESC LIMIT 10`,
    )
    .all(subject.kind, subject.id);
  return {
    subject: subject.key,
    canonical: canonical
      ? {
          name: canonical.name,
          description: canonical.description,
          aliases: parseJsonColumn(canonical.aliases_json, []),
          attributes: parseJsonColumn(canonical.canonical_json, {}),
          verified_by: "ha_api",
          verified_at: canonical.last_seen_at,
        }
      : null,
    memories,
    relationships: { outgoing, incoming },
    conflicts,
  };
}

export function searchMemory(db, query, options = {}) {
  let safeQuery;
  try {
    safeQuery = boundedUserText(query, 256, "Search query");
  } catch {
    throw new MemoryError("invalid_query", "Search query is empty, unsafe, or too long");
  }
  const limit = boundedResultLimit(
    options.limit,
    DEFAULT_SEARCH_LIMIT,
    MAX_SEARCH_LIMIT,
  );
  const subjectFilter = options.subject ? parseSubject(options.subject) : null;
  let subjectKeys;
  if (subjectFilter) {
    subjectKeys = [subjectFilter.key];
  } else {
    subjectKeys = db
      .prepare(
        `SELECT subject_key, bm25(search_fts) AS rank
         FROM search_fts WHERE search_fts MATCH ?
         ORDER BY rank, subject_key LIMIT ?`,
      )
      .all(ftsExpression(safeQuery), limit)
      .map((row) => row.subject_key);
    const direct = db
      .prepare(
        `SELECT kind || ':' || object_id AS subject_key
         FROM catalog_objects
         WHERE active = 1 AND (
           lower(object_id) = lower(?) OR lower(name) = lower(?)
         ) LIMIT 2`,
      )
      .all(safeQuery, safeQuery)
      .map((row) => row.subject_key);
    subjectKeys = [...new Set([...direct, ...subjectKeys])].slice(0, limit);
  }

  const results = subjectKeys
    .map((key) => subjectContext(db, parseSubject(key)))
    .filter(Boolean);
  const freshness = catalogFreshness(db);
  const response = {
    query: safeQuery,
    catalog: {
      status: freshness.status,
      last_verified_at: freshness.verified_at,
      age_seconds: freshness.age_seconds,
      stale: !freshness.fresh,
    },
    result_count: results.length,
    results,
    bounded: { result_limit: limit, byte_limit: MAX_SEARCH_BYTES },
  };
  while (
    response.results.length > 0 &&
    Buffer.byteLength(JSON.stringify(response), "utf8") > MAX_SEARCH_BYTES
  ) {
    response.results.pop();
    response.result_count = response.results.length;
  }
  return response;
}

export function showMemorySubject(db, subjectValue) {
  const subject = parseSubject(subjectValue);
  const context = subjectContext(db, subject, 30);
  if (!context) {
    throw new MemoryError(
      "subject_not_found",
      `Subject ${subject.key} is not active in the latest catalog`,
    );
  }
  return {
    ...context,
    catalog_last_verified_at: metadataGet(db, "last_successful_sync_at"),
  };
}

function validateMemoryKey(value) {
  let key;
  try {
    key = boundedUserText(value, 80, "Memory key");
  } catch {
    key = null;
  }
  if (!key || !/^[A-Za-z0-9_.-]+$/u.test(key)) {
    throw new MemoryError(
      "invalid_memory_key",
      "Memory key must use letters, numbers, dot, underscore, or hyphen",
    );
  }
  return key;
}

function memoryValueText(value) {
  const parts = [];
  const visit = (item) => {
    if (typeof item === "string") {
      const safe = safeText(item, 500);
      if (safe) parts.push(safe);
      return;
    }
    if (typeof item === "number" && Number.isFinite(item)) {
      parts.push(String(item));
      return;
    }
    if (typeof item === "boolean") {
      parts.push(String(item));
      return;
    }
    if (Array.isArray(item)) {
      for (const child of item) visit(child);
      return;
    }
    if (item && typeof item === "object") {
      for (const [key, child] of Object.entries(item)) {
        parts.push(key);
        visit(child);
      }
    }
  };
  visit(value);
  return parts.join(" ").slice(0, 4000);
}

function rejectTransientMemory(memoryType, memoryKey, value) {
  const normalizedKey = memoryKey.toLocaleLowerCase();
  if (
    /(^|[._-])(state|current_state|last_changed|last_updated|now)([._-]|$)/u.test(
      normalizedKey,
    )
  ) {
    throw new MemoryError(
      "transient_rejected",
      "Current state and timestamps cannot become durable Home Assistant memory",
    );
  }
  const serialized = stableJson(value);
  if (
    memoryType === "note" &&
    /\b(currently|right now|at the moment)\b|현재\s|지금\s/iu.test(serialized)
  ) {
    throw new MemoryError(
      "transient_rejected",
      "A time-local observation cannot become durable Home Assistant memory",
    );
  }
}

function normalizeCandidateMemoryValue(memoryType, value) {
  if (memoryType === "relationship") {
    const relationship = validateRelationshipValue(value);
    return { relation: relationship.relation, target: relationship.target.key };
  }
  if (memoryType === "alias") {
    const values = Array.isArray(value) ? value : [value];
    if (values.length === 0 || values.length > 20) {
      throw new MemoryError("invalid_value", "Alias memory requires 1 to 20 aliases");
    }
    const aliases = values.map((alias) =>
      boundedDurableText(alias, 300, "Alias memory value", "invalid_value"),
    );
    const unique = [...new Set(aliases)];
    if (unique.length !== aliases.length) {
      throw new MemoryError("invalid_value", "Alias memory values must be unique");
    }
    return Array.isArray(value) ? unique : unique[0];
  }
  if (["purpose", "preference", "note"].includes(memoryType)) {
    return boundedDurableText(value, 4000, "Memory value", "invalid_value");
  }
  throw new MemoryError("invalid_memory_type", `Unsupported memory type: ${memoryType}`);
}

function parseRelationshipTarget(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  if (typeof value.target === "string") {
    try {
      return parseSubject(value.target);
    } catch {
      return null;
    }
  }
  if (value.target && typeof value.target === "object") {
    try {
      return parseSubject(`${value.target.kind}:${value.target.id}`);
    } catch {
      return null;
    }
  }
  if (value.target_kind && value.target_id) {
    try {
      return parseSubject(`${value.target_kind}:${value.target_id}`);
    } catch {
      return null;
    }
  }
  return null;
}

function validateRelationshipValue(value) {
  if (!isPlainRecord(value)) {
    throw new MemoryError(
      "invalid_relationship",
      "Relationship memory value must be an object",
    );
  }
  const keys = Object.keys(value).sort();
  if (stableJson(keys) !== stableJson(["relation", "target"])) {
    throw new MemoryError(
      "invalid_relationship",
      "Relationship memory only accepts relation and target fields",
    );
  }
  const relation =
    typeof value.relation === "string" && value.relation.length <= 80
      ? safeText(value.relation, 80)
      : null;
  const target = parseRelationshipTarget(value);
  if (!relation || !/^[A-Za-z0-9_.-]+$/u.test(relation) || !target) {
    throw new MemoryError(
      "invalid_relationship",
      "Relationship value requires relation and target kind:id",
    );
  }
  return { relation, target };
}

function candidateView(row) {
  if (!row) return null;
  return {
    id: row.id,
    subject: `${row.subject_kind}:${row.subject_id}`,
    memory_type: row.memory_type,
    key: row.memory_key,
    value: parseJsonColumn(row.value_json, null),
    source: row.source_kind,
    source_ref: row.source_ref,
    status: row.status,
    verification_method: row.verification_method,
    change_id: row.change_id,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function createAuditRecorder(db, eventId) {
  let sequence = 0;
  return {
    eventId,
    nextSequence() {
      sequence += 1;
      return sequence;
    },
    inserted(tableName, id) {
      const after = readAuditedRow(db, tableName, id);
      recordAuditChange(
        db,
        eventId,
        this.nextSequence(),
        tableName,
        id,
        null,
        after,
      );
      return after;
    },
    updated(tableName, id, before) {
      const after = readAuditedRow(db, tableName, id);
      recordAuditChange(
        db,
        eventId,
        this.nextSequence(),
        tableName,
        id,
        before,
        after,
      );
      return after;
    },
  };
}

function addEvidenceWithinTransaction(
  db,
  audit,
  memoryId,
  evidenceType,
  detailValue,
) {
  if (!EVIDENCE_TYPES.has(evidenceType)) {
    throw new MemoryError("invalid_evidence", `Unsupported evidence type: ${evidenceType}`);
  }
  const detail = boundedEvidenceLabel(
    detailValue,
    "Evidence reference",
    "invalid_evidence",
  );
  const evidenceHash = hashText(`${evidenceType}\u0000${detail}`);
  const existing = db
    .prepare(
      `SELECT * FROM memory_evidence
       WHERE memory_id = ? AND evidence_type = ? AND evidence_hash = ?`,
    )
    .get(memoryId, evidenceType, evidenceHash);
  if (existing) return { row: existing, deduplicated: true };
  const result = db
    .prepare(
      `INSERT INTO memory_evidence(
        memory_id, evidence_type, detail, evidence_hash, created_at
      ) VALUES(?, ?, ?, ?, ?)`,
    )
    .run(memoryId, evidenceType, detail, evidenceHash, nowIso());
  const row = audit.inserted("memory_evidence", Number(result.lastInsertRowid));
  return { row, deduplicated: false };
}

export function proposeMemory(db, input) {
  const subject = parseSubject(input.subject);
  requireSubjectExists(db, subject);
  const memoryType = safeText(input.memoryType, 40);
  if (!MEMORY_TYPES.has(memoryType)) {
    throw new MemoryError("invalid_memory_type", `Unsupported memory type: ${memoryType}`);
  }
  const memoryKey = validateMemoryKey(input.key);
  const sourceKind = safeText(input.source, 40);
  if (!MEMORY_SOURCES.has(sourceKind)) {
    throw new MemoryError("invalid_source", `Unsupported memory source: ${sourceKind}`);
  }
  if (input.value === undefined || input.value === null) {
    throw new MemoryError("invalid_value", "Memory value must not be null");
  }
  const normalizedValue = normalizeCandidateMemoryValue(memoryType, input.value);
  rejectTransientMemory(memoryType, memoryKey, normalizedValue);
  const valueJson = ensureSafeUserPayload(normalizedValue, "Memory value");
  const valueText = memoryValueText(normalizedValue);
  if (!valueText) {
    throw new MemoryError("invalid_value", "Memory value has no searchable content");
  }
  const sourceRef = boundedEvidenceLabel(
    input.sourceRef,
    "Provenance reference",
    "invalid_source_ref",
  );

  const duplicate = db
    .prepare(
      `SELECT * FROM memory_items
         WHERE subject_kind = ? AND subject_id = ? AND memory_type = ?
         AND memory_key = ? AND value_json = ?
         AND authority >= ?
         AND status IN ('pending', 'verified', 'applied')
       ORDER BY id DESC LIMIT 1`,
    )
    .get(
      subject.kind,
      subject.id,
      memoryType,
      memoryKey,
      valueJson,
      SOURCE_AUTHORITY[sourceKind],
    );
  if (duplicate) {
    return { candidate: candidateView(duplicate), deduplicated: true };
  }

  return runTransaction(db, () => {
    const lockedDuplicate = db
      .prepare(
        `SELECT * FROM memory_items
           WHERE subject_kind = ? AND subject_id = ? AND memory_type = ?
           AND memory_key = ? AND value_json = ?
           AND authority >= ?
           AND status IN ('pending', 'verified', 'applied')
         ORDER BY id DESC LIMIT 1`,
      )
      .get(
        subject.kind,
        subject.id,
        memoryType,
        memoryKey,
        valueJson,
        SOURCE_AUTHORITY[sourceKind],
      );
    if (lockedDuplicate) {
      return { candidate: candidateView(lockedDuplicate), deduplicated: true };
    }
    const eventId = insertAuditEvent(db, {
      action: "memory_proposed",
      actor: sourceKind,
      subjectKey: subject.key,
      summary: `Proposed ${memoryType}.${memoryKey} memory candidate`,
      reversible: true,
    });
    const audit = createAuditRecorder(db, eventId);
    const at = nowIso();
    const result = db
      .prepare(
        `INSERT INTO memory_items(
          subject_kind, subject_id, memory_type, memory_key, value_json,
          value_text, source_kind, source_ref, authority, status,
          created_at, updated_at
        ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
      )
      .run(
        subject.kind,
        subject.id,
        memoryType,
        memoryKey,
        valueJson,
        valueText,
        sourceKind,
        sourceRef,
        SOURCE_AUTHORITY[sourceKind],
        at,
        at,
      );
    const candidateId = Number(result.lastInsertRowid);
    audit.inserted("memory_items", candidateId);
    const initialEvidenceType =
      sourceKind === "user_explicit"
        ? "user_explicit"
        : sourceKind === "observation"
          ? "observation"
          : "manual_review";
    addEvidenceWithinTransaction(
      db,
      audit,
      candidateId,
      initialEvidenceType,
      sourceRef,
    );
    return {
      candidate: candidateView(readAuditedRow(db, "memory_items", candidateId)),
      audit_event_id: eventId,
      deduplicated: false,
    };
  });
}

export function addMemoryEvidence(db, candidateIdValue, evidenceType, detail) {
  const candidateId = parsePositiveId(candidateIdValue, "Candidate ID");
  let candidate = readAuditedRow(db, "memory_items", candidateId);
  if (!candidate) {
    throw new MemoryError("candidate_not_found", `Memory candidate ${candidateId} not found`);
  }
  if (candidate.status !== "pending") {
    throw new MemoryError(
      "candidate_closed",
      `Memory candidate ${candidateId} is ${candidate.status}, not pending`,
    );
  }
  return runTransaction(db, () => {
    candidate = readAuditedRow(db, "memory_items", candidateId);
    if (!candidate || candidate.status !== "pending") {
      throw new MemoryError(
        "candidate_closed",
        `Memory candidate ${candidateId} changed before evidence could be added`,
      );
    }
    const eventId = insertAuditEvent(db, {
      action: "memory_evidence_added",
      actor: evidenceType,
      subjectKey: `${candidate.subject_kind}:${candidate.subject_id}`,
      summary: `Added ${evidenceType} evidence to candidate ${candidateId}`,
      reversible: true,
    });
    const audit = createAuditRecorder(db, eventId);
    const result = addEvidenceWithinTransaction(
      db,
      audit,
      candidateId,
      evidenceType,
      detail,
    );
    if (result.deduplicated) {
      db.prepare(
        `UPDATE audit_events SET action = 'memory_evidence_deduplicated',
          reversible = 0 WHERE id = ?`,
      ).run(eventId);
    }
    return {
      candidate_id: candidateId,
      evidence_id: result.row.id,
      deduplicated: result.deduplicated,
      audit_event_id: eventId,
    };
  });
}

function candidateRelationshipMatchesCatalog(db, candidate) {
  if (candidate.memory_type !== "relationship") return true;
  const value = parseJsonColumn(candidate.value_json, null);
  const { relation, target } = validateRelationshipValue(value);
  if (!subjectExists(db, target)) return false;
  if (!RESERVED_RELATIONSHIPS.has(relation)) return true;
  return Boolean(
    db
      .prepare(
        `SELECT 1 AS found FROM catalog_relations
         WHERE source_kind = ? AND source_id = ? AND relation = ?
           AND target_kind = ? AND target_id = ? AND active = 1`,
      )
      .get(
        candidate.subject_kind,
        candidate.subject_id,
        relation,
        target.kind,
        target.id,
      ),
  );
}

function reservedRelationshipSlot(memory) {
  if (memory?.memory_type !== "relationship") return null;
  try {
    const value = parseJsonColumn(memory.value_json, null);
    const { relation, target } = validateRelationshipValue(value);
    if (!RESERVED_RELATIONSHIPS.has(relation)) return null;
    return relation === "references"
      ? `${relation}:${target.key}`
      : relation;
  } catch {
    return null;
  }
}

function effectiveMemoryAuthority(db, memory) {
  return reservedRelationshipSlot(memory) &&
    memory.verification_method === "ha_api" &&
    candidateRelationshipMatchesCatalog(db, memory)
    ? STRUCTURAL_AUTHORITY
    : memory.authority;
}

function currentAppliedMemoryInSlot(db, candidate) {
  const structuralSlot = reservedRelationshipSlot(candidate);
  if (!structuralSlot) {
    return db
      .prepare(
        `SELECT * FROM memory_items
         WHERE subject_kind = ? AND subject_id = ? AND memory_type = ?
           AND memory_key = ? AND status = 'applied' AND id <> ?`,
      )
      .get(
        candidate.subject_kind,
        candidate.subject_id,
        candidate.memory_type,
        candidate.memory_key,
        candidate.id,
      );
  }
  return db
    .prepare(
      `SELECT * FROM memory_items
       WHERE subject_kind = ? AND subject_id = ? AND memory_type = 'relationship'
         AND status = 'applied' AND id <> ? ORDER BY id DESC`,
    )
    .all(candidate.subject_kind, candidate.subject_id, candidate.id)
    .find((memory) => reservedRelationshipSlot(memory) === structuralSlot);
}

function putCandidateInConflict(db, candidate, reason, eventAction) {
  const candidateId = candidate.id;
  const expectedStatus = candidate.status;
  return runTransaction(db, () => {
    candidate = readAuditedRow(db, "memory_items", candidateId);
    if (!candidate || candidate.status !== expectedStatus) {
      throw new MemoryError(
        "candidate_changed",
        `Memory candidate ${candidateId} changed before its conflict was recorded`,
      );
    }
    const lockedSubject = parseSubject(`${candidate.subject_kind}:${candidate.subject_id}`);
    if (reason === "ha_subject_missing" && subjectExists(db, lockedSubject)) {
      throw new MemoryError(
        "catalog_changed_retry",
        "The Home Assistant subject returned before its conflict was recorded; retry",
      );
    }
    if (
      reason === "ha_canonical_mismatch" &&
      candidateRelationshipMatchesCatalog(db, candidate)
    ) {
      throw new MemoryError(
        "catalog_changed_retry",
        "The Home Assistant relationship changed before its conflict was recorded; retry",
      );
    }
    const eventId = insertAuditEvent(db, {
      action: eventAction,
      actor: "validator",
      subjectKey: `${candidate.subject_kind}:${candidate.subject_id}`,
      summary: `Candidate ${candidate.id} conflicted with ${reason}`,
      reversible: true,
    });
    const audit = createAuditRecorder(db, eventId);
    const before = readAuditedRow(db, "memory_items", candidate.id);
    db.prepare(
      "UPDATE memory_items SET status = 'conflict', updated_at = ? WHERE id = ?",
    ).run(nowIso(), candidate.id);
    const after = audit.updated("memory_items", candidate.id, before);
    const conflict = openConflict(
      db,
      {
        subjectKind: candidate.subject_kind,
        subjectId: candidate.subject_id,
        memoryType: candidate.memory_type,
        memoryKey: candidate.memory_key,
        candidateMemoryId: candidate.id,
        reason,
        haValue: { matches: false },
      },
      audit,
    );
    return {
      candidate: candidateView(after),
      conflict_id: conflict.id,
      audit_event_id: eventId,
      verified: false,
    };
  });
}

function candidateChangePredicateHash(candidate) {
  if (candidate?.memory_type !== "relationship") return null;
  const value = parseJsonColumn(candidate.value_json, null);
  const { relation, target } = validateRelationshipValue(value);
  return hashText(stableJson({
    category: "relationship",
    subject: `${candidate.subject_kind}:${candidate.subject_id}`,
    field: `${relation}:${target.key}`,
    expected: true,
  }));
}

function changeVerificationEntailsCandidate(candidate, verification) {
  const predicateHash = candidateChangePredicateHash(candidate);
  return Boolean(
    predicateHash &&
      verification?.checks?.some(
        (check) => check?.matched === true && check.predicate_hash === predicateHash,
      ),
  );
}

export async function verifyMemoryCandidate(db, candidateIdValue, methodValue, options = {}) {
  const candidateId = parsePositiveId(candidateIdValue, "Candidate ID");
  let candidate = readAuditedRow(db, "memory_items", candidateId);
  if (!candidate) {
    throw new MemoryError("candidate_not_found", `Memory candidate ${candidateId} not found`);
  }
  if (candidate.status !== "pending") {
    throw new MemoryError(
      "candidate_not_pending",
      `Memory candidate ${candidateId} is ${candidate.status}, not pending`,
    );
  }
  const method = safeText(methodValue, 40);
  if (!VERIFICATION_METHODS.has(method)) {
    throw new MemoryError("invalid_verification", `Unsupported verification method: ${method}`);
  }

  if (method === "ha_api") {
    if (candidate.memory_type !== "relationship") {
      throw new MemoryError(
        "verification_scope_invalid",
        "HA API verification is only authoritative for structural relationship memory",
      );
    }
    await refreshMemory(db, { force: true });
    candidate = readAuditedRow(db, "memory_items", candidateId);
    if (!candidate || candidate.status !== "pending") {
      throw new MemoryError(
        "candidate_changed",
        `Memory candidate ${candidateId} changed during Home Assistant verification`,
      );
    }
  }

  const subject = parseSubject(`${candidate.subject_kind}:${candidate.subject_id}`);
  if (!subjectExists(db, subject)) {
    return putCandidateInConflict(
      db,
      candidate,
      "ha_subject_missing",
      "memory_verification_conflict",
    );
  }

  if (method === "user_explicit") {
    if (candidate.source_kind !== "user_explicit") {
      throw new MemoryError(
        "evidence_mismatch",
        "Only a user-explicit candidate can use user-explicit verification",
      );
    }
    const evidence = db
      .prepare(
        `SELECT COUNT(*) AS count FROM memory_evidence
         WHERE memory_id = ? AND evidence_type = 'user_explicit'`,
      )
      .get(candidateId).count;
    if (evidence < 1) {
      throw new MemoryError("evidence_missing", "User-explicit evidence is missing");
    }
    if (candidate.memory_type === "relationship") {
      const value = parseJsonColumn(candidate.value_json, null);
      const { relation } = validateRelationshipValue(value);
      if (RESERVED_RELATIONSHIPS.has(relation)) {
        throw new MemoryError(
          "canonical_fact_requires_ha",
          `Relationship ${relation} must be verified against Home Assistant`,
        );
      }
      candidateRelationshipMatchesCatalog(db, candidate);
    }
  } else if (method === "repeated_observation") {
    if (!["observation", "inference"].includes(candidate.source_kind)) {
      throw new MemoryError(
        "evidence_mismatch",
        "Repeated observation only verifies observation or inference candidates",
      );
    }
    const evidence = db
      .prepare(
        `SELECT COUNT(DISTINCT evidence_hash) AS count FROM memory_evidence
         WHERE memory_id = ? AND evidence_type = 'observation'`,
      )
      .get(candidateId).count;
    if (evidence < 2) {
      throw new MemoryError(
        "evidence_missing",
        "At least two distinct observations are required before verification",
      );
    }
  } else if (method === "ha_api") {
    if (!candidateRelationshipMatchesCatalog(db, candidate)) {
      return putCandidateInConflict(
        db,
        candidate,
        "ha_canonical_mismatch",
        "memory_verification_conflict",
      );
    }
  } else if (method === "change_verification") {
    if (candidate.source_kind !== "codex_change") {
      throw new MemoryError(
        "evidence_mismatch",
        "Only a Codex-change candidate can use change verification",
      );
    }
    const changeId = parsePositiveId(
      options.changeId ?? candidate.change_id,
      "Change ID",
    );
    const change = db
      .prepare("SELECT * FROM change_records WHERE id = ?")
      .get(changeId);
    if (!change || change.status !== "verified") {
      throw new MemoryError(
        "change_not_verified",
        "The linked Home Assistant change has not passed fresh API verification",
      );
    }
    const subjects = parseJsonColumn(change.subjects_json, []);
    if (!subjects.includes(subject.key)) {
      throw new MemoryError(
        "change_subject_mismatch",
        `Change ${changeId} did not verify subject ${subject.key}`,
      );
    }
    const verification = parseJsonColumn(change.verification_json, null);
    if (!changeVerificationEntailsCandidate(candidate, verification)) {
      throw new MemoryError(
        "change_fact_mismatch",
        `Change ${changeId} has no successful expectation proving this candidate fact`,
      );
    }
    options.changeId = changeId;
  }

  return runTransaction(db, () => {
    candidate = readAuditedRow(db, "memory_items", candidateId);
    if (!candidate || candidate.status !== "pending") {
      throw new MemoryError(
        "candidate_not_pending",
        `Memory candidate ${candidateId} changed before verification completed`,
      );
    }
    const lockedSubject = parseSubject(
      `${candidate.subject_kind}:${candidate.subject_id}`,
    );
    if (!subjectExists(db, lockedSubject)) {
      throw new MemoryError(
        "catalog_changed_retry",
        "The Home Assistant catalog changed during verification; retry the candidate",
      );
    }
    if (method === "ha_api" && !candidateRelationshipMatchesCatalog(db, candidate)) {
      throw new MemoryError(
        "catalog_changed_retry",
        "The Home Assistant relationship changed during verification; retry the candidate",
      );
    }
    if (method === "user_explicit") {
      const count = db
        .prepare(
          `SELECT COUNT(*) AS count FROM memory_evidence
           WHERE memory_id = ? AND evidence_type = 'user_explicit'`,
        )
        .get(candidateId).count;
      if (count < 1) {
        throw new MemoryError("evidence_missing", "User-explicit evidence changed");
      }
    }
    if (method === "repeated_observation") {
      const count = db
        .prepare(
          `SELECT COUNT(DISTINCT evidence_hash) AS count FROM memory_evidence
           WHERE memory_id = ? AND evidence_type = 'observation'`,
        )
        .get(candidateId).count;
      if (count < 2) {
        throw new MemoryError("evidence_missing", "Observation evidence changed");
      }
    }
    if (method === "change_verification") {
      const change = db
        .prepare("SELECT status, verification_json FROM change_records WHERE id = ?")
        .get(options.changeId);
      if (!change || change.status !== "verified") {
        throw new MemoryError(
          "change_not_verified",
          "The linked Home Assistant change changed before candidate verification",
        );
      }
      const lockedVerification = parseJsonColumn(change.verification_json, null);
      if (!changeVerificationEntailsCandidate(candidate, lockedVerification)) {
        throw new MemoryError(
          "change_fact_mismatch",
          "The linked change no longer proves this candidate fact",
        );
      }
    }
    const eventId = insertAuditEvent(db, {
      action: "memory_verified",
      actor: method,
      subjectKey: subject.key,
      summary: `Verified memory candidate ${candidateId} using ${method}`,
      reversible: true,
    });
    const audit = createAuditRecorder(db, eventId);
    const before = readAuditedRow(db, "memory_items", candidateId);
    const at = nowIso();
    db.prepare(
      `UPDATE memory_items SET
        status = 'verified', verification_method = ?, change_id = ?,
        verified_at = ?, updated_at = ?
       WHERE id = ?`,
    ).run(method, options.changeId ?? null, at, at, candidateId);
    const after = audit.updated("memory_items", candidateId, before);
    addEvidenceWithinTransaction(
      db,
      audit,
      candidateId,
      method === "repeated_observation" ? "observation" : method,
      method === "change_verification"
        ? `change-verification:${options.changeId}`
        : `verification:${method.replaceAll("_", "-")}`,
    );
    return {
      candidate: candidateView(after),
      audit_event_id: eventId,
      verified: true,
    };
  });
}

export function applyMemoryCandidate(db, candidateIdValue) {
  const candidateId = parsePositiveId(candidateIdValue, "Candidate ID");
  let candidate = readAuditedRow(db, "memory_items", candidateId);
  if (!candidate) {
    throw new MemoryError("candidate_not_found", `Memory candidate ${candidateId} not found`);
  }
  if (candidate.status !== "verified") {
    throw new MemoryError(
      "candidate_not_verified",
      `Memory candidate ${candidateId} is ${candidate.status}, not verified`,
    );
  }
  const subject = parseSubject(`${candidate.subject_kind}:${candidate.subject_id}`);
  requireSubjectExists(db, subject);
  if (
    candidate.memory_type === "relationship" &&
    !candidateRelationshipMatchesCatalog(db, candidate)
  ) {
    return putCandidateInConflict(
      db,
      candidate,
      "ha_canonical_mismatch",
      "memory_apply_conflict",
    );
  }

  return runTransaction(db, () => {
    candidate = readAuditedRow(db, "memory_items", candidateId);
    if (!candidate || candidate.status !== "verified") {
      throw new MemoryError(
        "candidate_not_verified",
        `Memory candidate ${candidateId} changed before it could be applied`,
      );
    }
    requireSubjectExists(
      db,
      parseSubject(`${candidate.subject_kind}:${candidate.subject_id}`),
    );
    if (
      candidate.memory_type === "relationship" &&
      !candidateRelationshipMatchesCatalog(db, candidate)
    ) {
      throw new MemoryError(
        "catalog_changed_retry",
        "The Home Assistant relationship changed before apply; verify again",
      );
    }
    const eventId = insertAuditEvent(db, {
      action: "memory_applied",
      actor: "validator",
      subjectKey: subject.key,
      summary: `Applied verified memory candidate ${candidateId}`,
      reversible: true,
    });
    const audit = createAuditRecorder(db, eventId);
    const existing = currentAppliedMemoryInSlot(db, candidate);
    const at = nowIso();
    let conflict = null;
    let resultStatus = "applied";
    const candidateAuthority = effectiveMemoryAuthority(db, candidate);
    const existingAuthority = existing
      ? effectiveMemoryAuthority(db, existing)
      : Number.NEGATIVE_INFINITY;

    if (!existing) {
      const before = readAuditedRow(db, "memory_items", candidateId);
      db.prepare(
        `UPDATE memory_items
         SET status = 'applied', applied_at = ?, updated_at = ? WHERE id = ?`,
      ).run(at, at, candidateId);
      audit.updated("memory_items", candidateId, before);
    } else if (
      existing.value_json === candidate.value_json &&
      candidateAuthority <= existingAuthority
    ) {
      const before = readAuditedRow(db, "memory_items", candidateId);
      db.prepare(
        `UPDATE memory_items
         SET status = 'superseded', supersedes_id = ?, updated_at = ? WHERE id = ?`,
      ).run(existing.id, at, candidateId);
      audit.updated("memory_items", candidateId, before);
      resultStatus = "duplicate";
    } else if (candidateAuthority > existingAuthority) {
      const beforeExisting = readAuditedRow(db, "memory_items", existing.id);
      db.prepare(
        `UPDATE memory_items
         SET status = 'superseded', updated_at = ? WHERE id = ?`,
      ).run(at, existing.id);
      audit.updated("memory_items", existing.id, beforeExisting);
      const beforeCandidate = readAuditedRow(db, "memory_items", candidateId);
      db.prepare(
        `UPDATE memory_items
         SET status = 'applied', supersedes_id = ?, applied_at = ?, updated_at = ?
         WHERE id = ?`,
      ).run(existing.id, at, at, candidateId);
      audit.updated("memory_items", candidateId, beforeCandidate);
      const staleConflicts = db
        .prepare(
          `SELECT * FROM conflicts
           WHERE existing_memory_id = ? AND status = 'open'`,
        )
        .all(existing.id);
      for (const staleConflict of staleConflicts) {
        const beforeStaleConflict = readAuditedRow(db, "conflicts", staleConflict.id);
        db.prepare(
          `UPDATE conflicts SET status = 'resolved',
            resolution = 'superseded_by_verified_candidate', resolved_at = ?
           WHERE id = ? AND status = 'open'`,
        ).run(at, staleConflict.id);
        audit.updated("conflicts", staleConflict.id, beforeStaleConflict);
      }
      conflict = openConflict(
        db,
        {
          subjectKind: candidate.subject_kind,
          subjectId: candidate.subject_id,
          memoryType: candidate.memory_type,
          memoryKey: candidate.memory_key,
          existingMemoryId: existing.id,
          candidateMemoryId: candidateId,
          reason: "higher_authority_candidate",
        },
        audit,
      );
      const beforeConflict = readAuditedRow(db, "conflicts", conflict.id);
      db.prepare(
        `UPDATE conflicts SET status = 'resolved',
          resolution = 'candidate_higher_authority', resolved_at = ? WHERE id = ?`,
      ).run(at, conflict.id);
      audit.updated("conflicts", conflict.id, beforeConflict);
      conflict = readAuditedRow(db, "conflicts", conflict.id);
      resultStatus = existing.value_json === candidate.value_json
        ? "provenance_upgraded"
        : "superseded_lower_authority";
    } else {
      const before = readAuditedRow(db, "memory_items", candidateId);
      db.prepare(
        "UPDATE memory_items SET status = 'conflict', updated_at = ? WHERE id = ?",
      ).run(at, candidateId);
      audit.updated("memory_items", candidateId, before);
      conflict = openConflict(
        db,
        {
          subjectKind: candidate.subject_kind,
          subjectId: candidate.subject_id,
          memoryType: candidate.memory_type,
          memoryKey: candidate.memory_key,
          existingMemoryId: existing.id,
          candidateMemoryId: candidateId,
          reason:
            candidateAuthority < existingAuthority
              ? "existing_memory_has_higher_authority"
              : "same_authority_disagreement",
        },
        audit,
      );
      resultStatus = "conflict";
    }
    rebuildSearchSubject(db, candidate.subject_kind, candidate.subject_id);
    return {
      candidate: candidateView(readAuditedRow(db, "memory_items", candidateId)),
      result: resultStatus,
      conflict_id: conflict?.id ?? null,
      audit_event_id: eventId,
    };
  });
}

export function rejectMemoryCandidate(db, candidateIdValue, reasonValue) {
  const candidateId = parsePositiveId(candidateIdValue, "Candidate ID");
  let candidate = readAuditedRow(db, "memory_items", candidateId);
  if (!candidate) {
    throw new MemoryError("candidate_not_found", `Memory candidate ${candidateId} not found`);
  }
  if (["applied", "rejected", "superseded"].includes(candidate.status)) {
    throw new MemoryError(
      "candidate_closed",
      `Memory candidate ${candidateId} is already ${candidate.status}`,
    );
  }
  const reason = boundedSummaryText(
    reasonValue,
    500,
    "Rejection reason",
    "invalid_reason",
  );
  return runTransaction(db, () => {
    candidate = readAuditedRow(db, "memory_items", candidateId);
    if (!candidate || ["applied", "rejected", "superseded"].includes(candidate.status)) {
      throw new MemoryError(
        "candidate_closed",
        `Memory candidate ${candidateId} changed before it could be rejected`,
      );
    }
    const eventId = insertAuditEvent(db, {
      action: "memory_rejected",
      actor: "reviewer",
      subjectKey: `${candidate.subject_kind}:${candidate.subject_id}`,
      summary: `Rejected memory candidate ${candidateId}: ${reason}`,
      reversible: true,
    });
    const audit = createAuditRecorder(db, eventId);
    const before = readAuditedRow(db, "memory_items", candidateId);
    const at = nowIso();
    db.prepare(
      `UPDATE memory_items
       SET status = 'rejected', rejected_at = ?, updated_at = ? WHERE id = ?`,
    ).run(at, at, candidateId);
    const after = audit.updated("memory_items", candidateId, before);
    const openConflicts = db
      .prepare(
        `SELECT * FROM conflicts
         WHERE candidate_memory_id = ? AND status = 'open'`,
      )
      .all(candidateId);
    for (const conflict of openConflicts) {
      const beforeConflict = readAuditedRow(db, "conflicts", conflict.id);
      db.prepare(
        `UPDATE conflicts SET status = 'resolved', resolution = 'candidate_rejected',
          resolved_at = ? WHERE id = ? AND status = 'open'`,
      ).run(at, conflict.id);
      audit.updated("conflicts", conflict.id, beforeConflict);
    }
    rebuildSearchSubject(db, candidate.subject_kind, candidate.subject_id);
    return {
      candidate: candidateView(after),
      audit_event_id: eventId,
    };
  });
}

export function listMemoryCandidates(db, options = {}) {
  const allowedStatuses = new Set([
    "pending",
    "verified",
    "applied",
    "rejected",
    "conflict",
    "superseded",
  ]);
  const status = options.status ?? "pending";
  if (!allowedStatuses.has(status)) {
    throw new MemoryError("invalid_status", `Unsupported candidate status: ${status}`);
  }
  const limit = boundedResultLimit(options.limit, 20, 100);
  return {
    status,
    candidates: db
      .prepare("SELECT * FROM memory_items WHERE status = ? ORDER BY id DESC LIMIT ?")
      .all(status, limit)
      .map(candidateView),
  };
}

function normalizeChangeSubjects(values) {
  const rawValues = Array.isArray(values) ? values : [values];
  if (rawValues.length === 0 || rawValues.length > 50) {
    throw new MemoryError(
      "invalid_change_subjects",
      "A change requires between 1 and 50 subjects",
    );
  }
  return [
    ...new Set(
      rawValues.map((value) => parseSubject(value).key),
    ),
  ];
}

const OBJECT_EXPECTATION_FIELDS = new Set([
  "exists", "name", "description", "area_id", "device_id", "active",
]);

function requireOnlyKeys(value, allowed, label) {
  if (!isPlainRecord(value)) {
    throw new MemoryError("invalid_expectations", `${label} must be an object`);
  }
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      throw new MemoryError("invalid_expectations", `${label} does not allow ${key}`);
    }
  }
}

function validateComparableJson(value, depth = 0) {
  if (depth > 8) {
    throw new MemoryError("invalid_expectations", "Expectation values are too deeply nested");
  }
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number" && Number.isFinite(value)) return;
  if (Array.isArray(value)) {
    for (const item of value) validateComparableJson(item, depth + 1);
    return;
  }
  if (isPlainRecord(value)) {
    for (const [key, item] of Object.entries(value)) {
      if (!key || Buffer.byteLength(key, "utf8") > 100 || /[\u0000-\u001f\u007f]/u.test(key)) {
        throw new MemoryError("invalid_expectations", "Expectation field names are unsafe");
      }
      validateComparableJson(item, depth + 1);
    }
    return;
  }
  throw new MemoryError("invalid_expectations", "Expectation values must be JSON data");
}

function normalizeObjectExpectations(rawObjects) {
  if (rawObjects === undefined) return [];
  let items;
  if (Array.isArray(rawObjects)) {
    items = rawObjects;
  } else if (isPlainRecord(rawObjects)) {
    items = Object.entries(rawObjects).map(([subject, expected]) => {
      if (!isPlainRecord(expected) || Object.hasOwn(expected, "subject")) {
        throw new MemoryError(
          "invalid_expectations",
          `Object expectation ${subject} must be a field object`,
        );
      }
      return { subject, ...expected };
    });
  } else {
    throw new MemoryError("invalid_expectations", "Object expectations must be a map or array");
  }
  const seen = new Set();
  const normalized = items.map((item) => {
    requireOnlyKeys(
      item,
      new Set(["subject", ...OBJECT_EXPECTATION_FIELDS]),
      "Object expectation",
    );
    const subject = parseSubject(item.subject);
    if (!CATALOG_KINDS.has(subject.kind) || seen.has(subject.key)) {
      throw new MemoryError("invalid_expectations", "Object expectation subject is invalid or duplicated");
    }
    seen.add(subject.key);
    const fields = Object.entries(item).filter(([field]) => field !== "subject");
    if (fields.length === 0) {
      throw new MemoryError("invalid_expectations", "Object expectation requires a field");
    }
    const result = { subject: subject.key };
    for (const [field, expected] of fields) {
      if (["exists", "active"].includes(field) && typeof expected !== "boolean") {
        throw new MemoryError("invalid_expectations", `${field} expectation must be boolean`);
      }
      if (
        !["exists", "active"].includes(field) &&
        expected !== null &&
        typeof expected !== "string"
      ) {
        throw new MemoryError("invalid_expectations", `${field} expectation must be string or null`);
      }
      result[field] = expected;
    }
    return result;
  });
  return normalized.sort((left, right) => left.subject.localeCompare(right.subject));
}

function canonicalizeChangeExpectations(expectations, declaredSubjectValues) {
  requireOnlyKeys(
    expectations,
    new Set(["objects", "relationships", "states"]),
    "Change expectations",
  );
  if (Object.values(expectations).some((value) => value === undefined)) {
    throw new MemoryError("invalid_expectations", "Expectation sections cannot be undefined");
  }
  let serialized;
  try {
    serialized = stableJson(expectations);
  } catch {
    throw new MemoryError("invalid_expectations", "Change expectations must be JSON data");
  }
  if (
    Buffer.byteLength(serialized, "utf8") > 16 * 1024 ||
    isSecretLike(serialized) ||
    isRawConversationLike(serialized)
  ) {
    throw new MemoryError(
      "invalid_expectations",
      "Change expectations are too large or contain unsafe data",
    );
  }

  const objects = normalizeObjectExpectations(expectations.objects);
  const relationships = [];
  if (expectations.relationships !== undefined) {
    if (!Array.isArray(expectations.relationships)) {
      throw new MemoryError("invalid_expectations", "Relationship expectations must be an array");
    }
    const seen = new Set();
    for (const item of expectations.relationships) {
      requireOnlyKeys(
        item,
        new Set(["source", "relation", "target", "exists"]),
        "Relationship expectation",
      );
      const source = parseSubject(item.source);
      const target = parseSubject(item.target);
      if (!CATALOG_KINDS.has(source.kind) || !CATALOG_KINDS.has(target.kind)) {
        throw new MemoryError("invalid_expectations", "Relationship subjects must be catalog objects");
      }
      const relation = typeof item.relation === "string" ? item.relation : "";
      if (
        Buffer.byteLength(relation, "utf8") > 80 ||
        !/^[A-Za-z0-9_.-]+$/u.test(relation) ||
        (Object.hasOwn(item, "exists") && typeof item.exists !== "boolean")
      ) {
        throw new MemoryError("invalid_expectations", "Relationship expectation is malformed");
      }
      const normalized = {
        source: source.key,
        relation,
        target: target.key,
        exists: item.exists ?? true,
      };
      const key = stableJson(normalized);
      if (seen.has(key)) {
        throw new MemoryError("invalid_expectations", "Relationship expectation is duplicated");
      }
      seen.add(key);
      relationships.push(normalized);
    }
    relationships.sort((left, right) => stableJson(left).localeCompare(stableJson(right)));
  }

  const states = {};
  if (expectations.states !== undefined) {
    if (!isPlainRecord(expectations.states)) {
      throw new MemoryError("invalid_expectations", "State expectations must be an object");
    }
    for (const subjectValue of Object.keys(expectations.states).sort()) {
      const subject = parseSubject(subjectValue);
      if (subject.kind !== "entity") {
        throw new MemoryError("invalid_expectations", "State expectations require entity subjects");
      }
      const expected = expectations.states[subjectValue];
      requireOnlyKeys(expected, new Set(["exists", "state", "attributes"]), "State expectation");
      if (Object.keys(expected).length === 0) {
        throw new MemoryError("invalid_expectations", "State expectation requires a field");
      }
      if (Object.hasOwn(expected, "exists") && typeof expected.exists !== "boolean") {
        throw new MemoryError("invalid_expectations", "State exists expectation must be boolean");
      }
      if (
        Object.hasOwn(expected, "state") &&
        expected.state !== null &&
        typeof expected.state !== "string"
      ) {
        throw new MemoryError("invalid_expectations", "State value expectation must be string or null");
      }
      if (Object.hasOwn(expected, "attributes") && !isPlainRecord(expected.attributes)) {
        throw new MemoryError("invalid_expectations", "State attributes must be an object");
      }
      for (const value of Object.values(expected.attributes ?? {})) validateComparableJson(value);
      states[subject.key] = stableValue(expected);
    }
  }

  const canonical = { objects, relationships, states };
  const summary = [];
  const covered = new Set();
  for (const item of objects) {
    covered.add(item.subject);
    for (const field of Object.keys(item).filter((field) => field !== "subject").sort()) {
      summary.push({ category: "object", subject: item.subject, field });
    }
  }
  for (const item of relationships) {
    covered.add(item.source);
    covered.add(item.target);
    summary.push({
      category: "relationship",
      subject: item.source,
      field: `${item.relation}:${item.target}`,
    });
    summary.push({
      category: "relationship_target",
      subject: item.target,
      field: `${item.relation}:${item.source}`,
    });
  }
  for (const [subject, expected] of Object.entries(states)) {
    covered.add(subject);
    for (const field of Object.keys(expected).sort()) {
      if (field === "attributes") {
        for (const attribute of Object.keys(expected.attributes).sort()) {
          summary.push({ category: "transient_state", subject, field: `attribute:${attribute}` });
        }
      } else {
        summary.push({ category: "transient_state", subject, field });
      }
    }
  }
  if (summary.length === 0) {
    throw new MemoryError("invalid_expectations", "At least one change expectation is required");
  }
  const declared = new Set(normalizeChangeSubjects(declaredSubjectValues));
  if (
    [...covered].some((subject) => !declared.has(subject)) ||
    [...declared].some((subject) => !covered.has(subject))
  ) {
    throw new MemoryError(
      "expectation_subject_mismatch",
      "Expectation subjects must exactly cover the declared change subjects",
    );
  }
  const canonicalJson = stableJson(canonical);
  return {
    canonical,
    canonical_json: canonicalJson,
    hash: hashText(canonicalJson),
    summary,
  };
}

export function beginMemoryChange(db, summaryValue, subjectValues, expectations) {
  const summary = boundedSummaryText(
    summaryValue,
    500,
    "Change summary",
    "invalid_summary",
  );
  const subjects = normalizeChangeSubjects(subjectValues);
  const contract = canonicalizeChangeExpectations(expectations, subjects);
  return runTransaction(db, () => {
    const beforeSyncId = latestSuccessfulSyncId(db);
    const eventId = insertAuditEvent(db, {
      action: "change_started",
      actor: "codex",
      subjectKey: subjects[0],
      summary: `Started Home Assistant change: ${summary}`,
      correlationId: null,
      reversible: false,
    });
    const audit = createAuditRecorder(db, eventId);
    const result = db
      .prepare(
        `INSERT INTO change_records(
          summary, subjects_json, status, before_sync_id, expectation_hash,
          expectation_summary_json, created_at
        ) VALUES(?, ?, 'pending', ?, ?, ?, ?)`,
      )
      .run(
        summary,
        stableJson(subjects),
        beforeSyncId,
        contract.hash,
        stableJson(contract.summary),
        nowIso(),
      );
    const changeId = Number(result.lastInsertRowid);
    audit.inserted("change_records", changeId);
    db.prepare("UPDATE audit_events SET correlation_id = ? WHERE id = ?").run(
      `change:${changeId}`,
      eventId,
    );
    return {
      change_id: changeId,
      status: "pending",
      subjects,
      before_sync_id: beforeSyncId,
      expectation_hash: contract.hash,
      expectation_summary: contract.summary,
      audit_event_id: eventId,
    };
  });
}

function compareExpected(actual, expected) {
  return stableJson(actual) === stableJson(expected);
}

function expectationVerificationCheck(category, subject, field, expected, matched) {
  return {
    category,
    subject,
    field,
    predicate_hash: hashText(stableJson({ category, subject, field, expected })),
    matched,
  };
}

function verifyExpectations(normalizedSnapshot, rawSnapshot, canonical) {
  const checks = [];
  for (const item of canonical.objects) {
    const subject = parseSubject(item.subject);
    const row = normalizedSnapshot.objects.get(subject.key);
    const attributes = row ? parseJsonColumn(row.canonical_json, {}) : {};
    for (const [field, expected] of Object.entries(item)) {
      if (field === "subject") continue;
      let actual;
      if (field === "exists" || field === "active") actual = Boolean(row);
      else if (field === "name" || field === "description") actual = row?.[field] ?? null;
      else actual = attributes[field] ?? null;
      checks.push(expectationVerificationCheck(
        "object",
        subject.key,
        field,
        expected,
        compareExpected(actual, expected),
      ));
    }
  }
  for (const item of canonical.relationships) {
    const source = parseSubject(item.source);
    const target = parseSubject(item.target);
    const relationKey = `${source.kind}:${source.id}|${item.relation}|${target.kind}:${target.id}`;
    const matched = normalizedSnapshot.relations.has(relationKey) === item.exists;
    checks.push(expectationVerificationCheck(
      "relationship",
      source.key,
      `${item.relation}:${target.key}`,
      item.exists,
      matched,
    ));
    checks.push(expectationVerificationCheck(
      "relationship_target",
      target.key,
      `${item.relation}:${source.key}`,
      item.exists,
      matched,
    ));
  }
  const stateById = new Map(rawSnapshot.states.map((state) => [state.entity_id, state]));
  for (const [subjectValue, expected] of Object.entries(canonical.states)) {
    const subject = parseSubject(subjectValue);
    const actualState = stateById.get(subject.id);
    if (Object.hasOwn(expected, "exists")) {
      checks.push(expectationVerificationCheck(
        "transient_state",
        subject.key,
        "exists",
        expected.exists,
        Boolean(actualState) === expected.exists,
      ));
    }
    if (Object.hasOwn(expected, "state")) {
      checks.push(expectationVerificationCheck(
        "transient_state",
        subject.key,
        "state",
        expected.state,
        compareExpected(actualState?.state ?? null, expected.state),
      ));
    }
    for (const [attribute, expectedValue] of Object.entries(expected.attributes ?? {})) {
      checks.push(expectationVerificationCheck(
        "transient_state",
        subject.key,
        `attribute:${attribute}`,
        expectedValue,
        compareExpected(actualState?.attributes?.[attribute] ?? null, expectedValue),
      ));
    }
  }
  return {
    matched: checks.every((check) => check.matched),
    persisted_verification: checks,
  };
}

function markChangeUnavailable(db, changeId, reasonCode) {
  return runTransaction(db, () => {
    const current = readAuditedRow(db, "change_records", changeId);
    if (!current || current.status === "verified") {
      throw new MemoryError(
        "change_closed",
        `Home Assistant change ${changeId} changed before verification completed`,
      );
    }
    const eventId = insertAuditEvent(db, {
      action: "change_verification_unavailable",
      actor: "ha_api",
      summary: `Home Assistant change ${changeId} could not be verified (${reasonCode})`,
      correlationId: `change:${changeId}`,
      reversible: false,
    });
    const audit = createAuditRecorder(db, eventId);
    const before = current;
    const verification = {
      matched: false,
      unavailable: true,
      reason: reasonCode,
      checks: [],
    };
    db.prepare(
      `UPDATE change_records SET
        status = 'unavailable', verification_json = ?, verified_at = ?
       WHERE id = ?`,
    ).run(stableJson(verification), nowIso(), changeId);
    const after = audit.updated("change_records", changeId, before);
    return {
      change_id: changeId,
      status: after.status,
      verification,
      audit_event_id: eventId,
    };
  });
}

export async function verifyMemoryChange(db, changeIdValue, expectations) {
  const changeId = parsePositiveId(changeIdValue, "Change ID");
  let change = readAuditedRow(db, "change_records", changeId);
  if (!change) {
    throw new MemoryError("change_not_found", `Home Assistant change ${changeId} not found`);
  }
  if (change.status === "verified") {
    throw new MemoryError("change_closed", `Home Assistant change ${changeId} is already verified`);
  }
  const subjects = parseJsonColumn(change.subjects_json, []);
  const contract = canonicalizeChangeExpectations(expectations, subjects);
  if (
    change.expectation_hash !== contract.hash ||
    change.expectation_summary_json !== stableJson(contract.summary)
  ) {
    throw new MemoryError(
      "expectations_changed",
      "Verification expectations do not match the contract committed at change start",
    );
  }

  let refresh;
  try {
    refresh = await refreshMemory(db, {
      force: true,
      returnRaw: true,
      returnNormalized: true,
    });
    if (refresh.reason === "newer_refresh_already_applied") {
      refresh = await refreshMemory(db, {
        force: true,
        returnRaw: true,
        returnNormalized: true,
      });
    }
    if (refresh.reason === "newer_refresh_already_applied") {
      return markChangeUnavailable(db, changeId, "concurrent_refresh");
    }
  } catch (error) {
    const reasonCode =
      error instanceof HomeAssistantUnavailableError
        ? homeAssistantErrorCode(error)
        : error instanceof MemoryError
          ? error.code
          : "refresh_failed";
    return markChangeUnavailable(db, changeId, reasonCode);
  }
  const verification = verifyExpectations(
    refresh.normalized_snapshot,
    refresh.raw_snapshot,
    contract.canonical,
  );
  change = readAuditedRow(db, "change_records", changeId);
  return runTransaction(db, () => {
    change = readAuditedRow(db, "change_records", changeId);
    if (
      !change ||
      change.status === "verified" ||
      change.expectation_hash !== contract.hash ||
      change.expectation_summary_json !== stableJson(contract.summary)
    ) {
      throw new MemoryError(
        "change_closed",
        `Home Assistant change ${changeId} changed before verification completed`,
      );
    }
    const status = verification.matched ? "verified" : "mismatch";
    const eventId = insertAuditEvent(db, {
      action: verification.matched
        ? "change_verified"
        : "change_verification_mismatch",
      actor: "ha_api",
      subjectKey: parseJsonColumn(change.subjects_json, [null])[0],
      summary: verification.matched
        ? `Verified Home Assistant change ${changeId} against fresh API data`
        : `Home Assistant change ${changeId} did not match fresh API data`,
      correlationId: `change:${changeId}`,
      reversible: false,
    });
    const audit = createAuditRecorder(db, eventId);
    const before = readAuditedRow(db, "change_records", changeId);
    const at = nowIso();
    const persisted = {
      matched: verification.matched,
      unavailable: false,
      checks: verification.persisted_verification,
    };
    db.prepare(
      `UPDATE change_records SET
        status = ?, after_sync_id = ?, verification_json = ?, verified_at = ?
       WHERE id = ?`,
    ).run(
      status,
      refresh.sync_id,
      stableJson(persisted),
      at,
      changeId,
    );
    const after = audit.updated("change_records", changeId, before);
    let conflictId = null;
    const conflictKey = `change.${changeId}`;
    if (!verification.matched) {
      const subjects = parseJsonColumn(change.subjects_json, []);
      const subject = parseSubject(subjects[0]);
      const failedChecks = verification.persisted_verification.filter(
        (check) => !check.matched,
      );
      const conflict = openConflict(
        db,
        {
          subjectKind: subject.kind,
          subjectId: subject.id,
          memoryType: null,
          memoryKey: conflictKey,
          reason: "change_expectation_mismatch",
          haValue: {
            matched: false,
            failed_check_count: failedChecks.length,
            failed_fields: failedChecks
              .slice(0, 10)
              .map((check) => `${check.subject}:${check.field}`.slice(0, 350)),
          },
        },
        audit,
      );
      conflictId = conflict.id;
    } else {
      const openRows = db
        .prepare(
          `SELECT * FROM conflicts
           WHERE memory_key = ? AND reason = 'change_expectation_mismatch'
             AND status = 'open'`,
        )
        .all(conflictKey);
      for (const row of openRows) {
        const beforeConflict = readAuditedRow(db, "conflicts", row.id);
        db.prepare(
          `UPDATE conflicts SET status = 'resolved',
            resolution = 'later_api_verification_passed', resolved_at = ?
           WHERE id = ?`,
        ).run(at, row.id);
        audit.updated("conflicts", row.id, beforeConflict);
      }
    }
    return {
      change_id: changeId,
      status: after.status,
      matched: verification.matched,
      checks: verification.persisted_verification,
      transient_values_persisted: false,
      conflict_id: conflictId,
      after_sync_id: refresh.sync_id,
      audit_event_id: eventId,
    };
  });
}

export function listMemoryConflicts(db, options = {}) {
  const status = options.status ?? "open";
  if (!["open", "resolved"].includes(status)) {
    throw new MemoryError("invalid_status", "Conflict status must be open or resolved");
  }
  const limit = boundedResultLimit(options.limit, 20, 100);
  return {
    status,
    conflicts: db
      .prepare(
        `SELECT id, subject_kind, subject_id, memory_type, memory_key,
                existing_memory_id, candidate_memory_id, reason, status,
                resolution, created_at, resolved_at
         FROM conflicts WHERE status = ? ORDER BY id DESC LIMIT ?`,
      )
      .all(status, limit)
      .map((row) => {
        const existingMemory = row.existing_memory_id
          ? candidateView(readAuditedRow(db, "memory_items", row.existing_memory_id))
          : null;
        const candidateMemory = row.candidate_memory_id
          ? candidateView(readAuditedRow(db, "memory_items", row.candidate_memory_id))
          : null;
        return {
          ...row,
          subject: `${row.subject_kind}:${row.subject_id}`,
          existing_memory: existingMemory,
          candidate_memory: candidateMemory,
        };
      }),
  };
}

function changeMismatchConflictStillCurrent(db, conflict) {
  if (
    conflict.reason !== "change_expectation_mismatch" ||
    typeof conflict.memory_key !== "string"
  ) {
    return false;
  }
  const match = /^change\.([1-9][0-9]*)$/u.exec(conflict.memory_key);
  if (!match) return false;
  const changeId = Number(match[1]);
  if (!Number.isSafeInteger(changeId)) return false;
  return db.prepare("SELECT status FROM change_records WHERE id = ?").get(changeId)?.status ===
    "mismatch";
}

export function resolveMemoryConflict(db, conflictIdValue, winnerValue, reasonValue) {
  const conflictId = parsePositiveId(conflictIdValue, "Conflict ID");
  let conflict = readAuditedRow(db, "conflicts", conflictId);
  if (!conflict) {
    throw new MemoryError("conflict_not_found", `Memory conflict ${conflictId} not found`);
  }
  if (conflict.status !== "open") {
    throw new MemoryError("conflict_closed", `Memory conflict ${conflictId} is resolved`);
  }
  const winner = safeText(winnerValue, 20);
  if (!["candidate", "existing", "ha"].includes(winner)) {
    throw new MemoryError(
      "invalid_winner",
      "Conflict winner must be candidate, existing, or ha",
    );
  }
  const reason = boundedSummaryText(
    reasonValue,
    500,
    "Resolution reason",
    "invalid_reason",
  );
  if (winner === "candidate" && !conflict.candidate_memory_id) {
    throw new MemoryError("invalid_winner", "This conflict has no candidate memory");
  }
  if (winner === "existing" && !conflict.existing_memory_id) {
    throw new MemoryError("invalid_winner", "This conflict has no existing memory");
  }
  const haAuthorityConflict = HA_AUTHORITY_CONFLICT_REASONS.has(conflict.reason);
  if (haAuthorityConflict && winner !== "ha") {
    throw new MemoryError(
      "invalid_winner",
      "A Home Assistant canonical or change-result conflict can only be resolved in favor of ha",
    );
  }
  if (!haAuthorityConflict && winner === "ha") {
    throw new MemoryError(
      "invalid_winner",
      "Home Assistant can only win a canonical structure or change-result conflict",
    );
  }

  return runTransaction(db, () => {
    conflict = readAuditedRow(db, "conflicts", conflictId);
    if (!conflict || conflict.status !== "open") {
      throw new MemoryError(
        "conflict_closed",
        `Memory conflict ${conflictId} changed before it could be resolved`,
      );
    }
    const candidate = conflict.candidate_memory_id
      ? readAuditedRow(db, "memory_items", conflict.candidate_memory_id)
      : null;
    const existing = conflict.existing_memory_id
      ? readAuditedRow(db, "memory_items", conflict.existing_memory_id)
      : null;
    if (candidate && candidate.status !== "conflict") {
      throw new MemoryError("conflict_changed", "Conflict candidate is no longer current");
    }
    if (existing && existing.status !== "applied") {
      throw new MemoryError("conflict_changed", "Conflict existing memory is no longer applied");
    }
    if (candidate && existing) {
      const current = currentAppliedMemoryInSlot(db, candidate);
      if (!current || current.id !== existing.id) {
        throw new MemoryError("conflict_changed", "Conflict memory slot changed before resolution");
      }
    }
    if (winner === "candidate" && !candidate) {
      throw new MemoryError("conflict_changed", "Conflict candidate no longer exists");
    }
    if (winner === "existing" && !existing) {
      throw new MemoryError("conflict_changed", "Conflict existing memory no longer exists");
    }
    if (winner === "ha") {
      const subject = parseSubject(`${conflict.subject_kind}:${conflict.subject_id}`);
      const conflictStillCurrent =
        (conflict.reason === "ha_subject_missing" && !subjectExists(db, subject)) ||
        (conflict.reason === "ha_canonical_mismatch" &&
          candidate && !candidateRelationshipMatchesCatalog(db, candidate)) ||
        (conflict.reason === "ha_canonical_relationship_changed" &&
          existing && !candidateRelationshipMatchesCatalog(db, existing)) ||
        changeMismatchConflictStillCurrent(db, conflict);
      if (!conflictStillCurrent) {
        throw new MemoryError(
          "catalog_changed_retry",
          "Home Assistant canonical structure changed before conflict resolution",
        );
      }
    }
    const eventId = insertAuditEvent(db, {
      action: "conflict_resolved",
      actor: "user_direction",
      subjectKey: `${conflict.subject_kind}:${conflict.subject_id}`,
      summary: `Resolved memory conflict ${conflictId} in favor of ${winner}: ${reason}`,
      reversible: true,
    });
    const audit = createAuditRecorder(db, eventId);
    const at = nowIso();
    if (winner === "candidate") {
      if (conflict.existing_memory_id) {
        const beforeExisting = readAuditedRow(
          db,
          "memory_items",
          conflict.existing_memory_id,
        );
        db.prepare(
          "UPDATE memory_items SET status = 'superseded', updated_at = ? WHERE id = ?",
        ).run(at, conflict.existing_memory_id);
        audit.updated(
          "memory_items",
          conflict.existing_memory_id,
          beforeExisting,
        );
      }
      const beforeCandidate = readAuditedRow(
        db,
        "memory_items",
        conflict.candidate_memory_id,
      );
      db.prepare(
        `UPDATE memory_items SET
          status = 'applied', supersedes_id = ?, applied_at = ?, updated_at = ?
         WHERE id = ?`,
      ).run(
        conflict.existing_memory_id,
        at,
        at,
        conflict.candidate_memory_id,
      );
      audit.updated(
        "memory_items",
        conflict.candidate_memory_id,
        beforeCandidate,
      );
    } else if (conflict.candidate_memory_id) {
      const beforeCandidate = readAuditedRow(
        db,
        "memory_items",
        conflict.candidate_memory_id,
      );
      db.prepare(
        `UPDATE memory_items SET
          status = 'rejected', rejected_at = ?, updated_at = ? WHERE id = ?`,
      ).run(at, at, conflict.candidate_memory_id);
      audit.updated(
        "memory_items",
        conflict.candidate_memory_id,
        beforeCandidate,
      );
    }
    if (winner === "ha" && conflict.existing_memory_id) {
      const beforeExisting = readAuditedRow(
        db,
        "memory_items",
        conflict.existing_memory_id,
      );
      if (beforeExisting?.status === "applied") {
        db.prepare(
          "UPDATE memory_items SET status = 'superseded', updated_at = ? WHERE id = ?",
        ).run(at, conflict.existing_memory_id);
        audit.updated("memory_items", conflict.existing_memory_id, beforeExisting);
      }
    }
    const beforeConflict = readAuditedRow(db, "conflicts", conflictId);
    db.prepare(
      `UPDATE conflicts SET status = 'resolved', resolution = ?, resolved_at = ?
       WHERE id = ?`,
    ).run(`${winner}: ${reason}`, at, conflictId);
    const afterConflict = audit.updated(
      "conflicts",
      conflictId,
      beforeConflict,
    );
    rebuildSearchSubject(db, conflict.subject_kind, conflict.subject_id);
    return {
      conflict: {
        id: afterConflict.id,
        status: afterConflict.status,
        resolution: afterConflict.resolution,
      },
      audit_event_id: eventId,
    };
  });
}

export function memoryHistory(db, options = {}) {
  const limit = boundedResultLimit(options.limit, 30, 100);
  const subject = options.subject ? parseSubject(options.subject) : null;
  const events = subject
    ? db
        .prepare(
          `SELECT id, action, actor, subject_key, summary, correlation_id,
                  reversible, rollback_of_event_id, rolled_back_by_event_id, created_at
           FROM audit_events WHERE subject_key = ? ORDER BY id DESC LIMIT ?`,
        )
        .all(subject.key, limit)
    : db
        .prepare(
          `SELECT id, action, actor, subject_key, summary, correlation_id,
                  reversible, rollback_of_event_id, rolled_back_by_event_id, created_at
           FROM audit_events ORDER BY id DESC LIMIT ?`,
        )
        .all(limit);
  const catalogRevisions = subject
    ? db
        .prepare(
          `SELECT id, sync_id, subject_kind, subject_id, change_type,
                  changed_fields_json, created_at
           FROM catalog_revisions
           WHERE subject_kind = ? AND subject_id = ? ORDER BY id DESC LIMIT ?`,
        )
        .all(subject.kind, subject.id, limit)
        .map((row) => ({
          ...row,
          subject: `${row.subject_kind}:${row.subject_id}`,
          changed_fields: parseJsonColumn(row.changed_fields_json, []),
          changed_fields_json: undefined,
        }))
    : [];
  return {
    subject: subject?.key ?? null,
    events,
    catalog_revisions: catalogRevisions,
    note: "Rollback applies only to reversible semantic-memory events, never the HA catalog",
  };
}

function writeAuditedRow(db, tableName, row) {
  const columns = AUDITED_TABLE_COLUMNS[tableName];
  if (!columns) {
    throw new MemoryError("audit_table_rejected", `Table ${tableName} cannot be restored`);
  }
  const values = columns.map((column) => row[column] ?? null);
  const placeholders = columns.map(() => "?").join(", ");
  const updates = columns
    .filter((column) => column !== "id")
    .map((column) => `${column} = excluded.${column}`)
    .join(", ");
  db.prepare(
    `INSERT INTO ${tableName}(${columns.join(", ")}) VALUES(${placeholders})
     ON CONFLICT(id) DO UPDATE SET ${updates}`,
  ).run(...values);
}

function deleteAuditedRow(db, tableName, id) {
  if (!Object.hasOwn(AUDITED_TABLE_COLUMNS, tableName)) {
    throw new MemoryError("audit_table_rejected", `Table ${tableName} cannot be deleted`);
  }
  db.prepare(`DELETE FROM ${tableName} WHERE id = ?`).run(id);
}

function coalesceAuditChanges(rows, eventId) {
  const grouped = new Map();
  for (const row of rows) {
    const key = `${row.table_name}\u0000${row.row_key_json}`;
    const prior = grouped.get(key);
    if (!prior) {
      grouped.set(key, { ...row });
      continue;
    }
    if (stableJson(parseJsonColumn(prior.after_json, null)) !==
        stableJson(parseJsonColumn(row.before_json, null))) {
      throw new MemoryError(
        "audit_chain_invalid",
        `Audit event ${eventId} has a non-contiguous row history`,
      );
    }
    prior.after_json = row.after_json;
    prior.sequence = row.sequence;
  }
  return [...grouped.values()].sort((left, right) => right.sequence - left.sequence);
}

function rollbackDeletionSet(changes, tableName) {
  return new Set(
    changes
      .filter((change) => change.table_name === tableName && change.before_json === null)
      .map((change) => parseJsonColumn(change.row_key_json, {}).id),
  );
}

function laterAuditDependsOnMemory(db, eventId, memoryId) {
  const later = db
    .prepare(
      `SELECT event_id, table_name, row_key_json, before_json, after_json
       FROM audit_changes WHERE event_id > ?`,
    )
    .all(eventId);
  return later.some((change) => {
    const key = parseJsonColumn(change.row_key_json, {});
    const before = parseJsonColumn(change.before_json, null);
    const after = parseJsonColumn(change.after_json, null);
    if (change.table_name === "memory_items" && key.id === memoryId) return true;
    if (change.table_name === "memory_evidence") {
      return before?.memory_id === memoryId || after?.memory_id === memoryId;
    }
    if (change.table_name === "conflicts") {
      return [
        before?.existing_memory_id,
        before?.candidate_memory_id,
        after?.existing_memory_id,
        after?.candidate_memory_id,
      ].includes(memoryId);
    }
    return false;
  });
}

function validateRollbackDependencies(db, changes, eventId) {
  for (const change of changes) {
    if (change.table_name !== "memory_evidence" || change.before_json !== null) {
      continue;
    }
    const evidence = parseJsonColumn(change.after_json, null);
    if (!evidence) continue;
    const memory = readAuditedRow(db, "memory_items", evidence.memory_id);
    if (!memory || memory.status === "pending") continue;
    const sameEventRestoresPending = changes.some((candidateChange) => {
      if (candidateChange.table_name !== "memory_items") return false;
      const key = parseJsonColumn(candidateChange.row_key_json, null);
      const before = parseJsonColumn(candidateChange.before_json, null);
      return key?.id === evidence.memory_id && before?.status === "pending";
    });
    if (!sameEventRestoresPending) {
      throw new MemoryError(
        "rollback_dependency",
        `Cannot roll back event ${eventId}; candidate ${evidence.memory_id} already used its evidence`,
      );
    }
  }
  const evidenceDeletes = rollbackDeletionSet(changes, "memory_evidence");
  const conflictDeletes = rollbackDeletionSet(changes, "conflicts");
  for (const change of changes) {
    if (change.table_name !== "memory_items" || change.before_json !== null) continue;
    const memory = parseJsonColumn(change.after_json, null);
    if (!memory) continue;
    const dependentEvidence = db
      .prepare("SELECT id FROM memory_evidence WHERE memory_id = ?")
      .all(memory.id)
      .some((row) => !evidenceDeletes.has(row.id));
    const dependentConflicts = db
      .prepare(
        `SELECT id FROM conflicts
         WHERE existing_memory_id = ? OR candidate_memory_id = ?`,
      )
      .all(memory.id, memory.id)
      .some((row) => !conflictDeletes.has(row.id));
    if (
      dependentEvidence ||
      dependentConflicts ||
      laterAuditDependsOnMemory(db, eventId, memory.id)
    ) {
      throw new MemoryError(
        "rollback_dependency",
        `Cannot delete candidate ${memory.id}; later audit or evidence depends on it`,
      );
    }
  }
}

export function rollbackMemoryEvent(db, eventIdValue, reasonValue) {
  const eventId = parsePositiveId(eventIdValue, "Audit event ID");
  const event = db.prepare("SELECT * FROM audit_events WHERE id = ?").get(eventId);
  if (!event) throw new MemoryError("event_not_found", `Audit event ${eventId} not found`);
  if (event.reversible !== 1) {
    throw new MemoryError(
      "event_not_reversible",
      "This event is authoritative HA catalog/change history and cannot be rolled back",
    );
  }
  if (event.rolled_back_by_event_id) {
    throw new MemoryError(
      "event_already_rolled_back",
      `Audit event ${eventId} was already rolled back`,
    );
  }
  const reason = boundedSummaryText(
    reasonValue,
    500,
    "Rollback reason",
    "invalid_reason",
  );
  const rawChanges = db
    .prepare("SELECT * FROM audit_changes WHERE event_id = ? ORDER BY sequence")
    .all(eventId);
  const changes = coalesceAuditChanges(rawChanges, eventId);
  if (changes.length === 0) {
    throw new MemoryError("event_not_reversible", "Audit event has no reversible changes");
  }

  validateRollbackDependencies(db, changes, eventId);

  for (const change of changes) {
    const key = parseJsonColumn(change.row_key_json, null);
    const current = readAuditedRow(db, change.table_name, key?.id);
    const expectedAfter = parseJsonColumn(change.after_json, null);
    if (stableJson(current) !== stableJson(expectedAfter)) {
      throw new MemoryError(
        "rollback_diverged",
        `Cannot roll back event ${eventId}; ${change.table_name}:${key?.id} changed later`,
      );
    }
  }

  return runTransaction(db, () => {
    const currentEvent = db
      .prepare("SELECT rolled_back_by_event_id FROM audit_events WHERE id = ?")
      .get(eventId);
    if (!currentEvent || currentEvent.rolled_back_by_event_id) {
      throw new MemoryError(
        "event_already_rolled_back",
        `Audit event ${eventId} changed before rollback started`,
      );
    }
    validateRollbackDependencies(db, changes, eventId);
    for (const change of changes) {
      const key = parseJsonColumn(change.row_key_json, null);
      const current = readAuditedRow(db, change.table_name, key?.id);
      const expectedAfter = parseJsonColumn(change.after_json, null);
      if (stableJson(current) !== stableJson(expectedAfter)) {
        throw new MemoryError(
          "rollback_diverged",
          `Cannot roll back event ${eventId}; ${change.table_name}:${key?.id} changed concurrently`,
        );
      }
    }
    const rollbackEventId = insertAuditEvent(db, {
      action: "memory_rollback",
      actor: "user_direction",
      subjectKey: event.subject_key,
      summary: `Rolled back audit event ${eventId}: ${reason}`,
      correlationId: event.correlation_id,
      reversible: false,
      rollbackOfEventId: eventId,
    });
    let sequence = 0;
    const affectedSubjects = new Set();
    for (const change of changes) {
      const key = parseJsonColumn(change.row_key_json, null);
      const current = readAuditedRow(db, change.table_name, key.id);
      const target = parseJsonColumn(change.before_json, null);
      if (change.table_name === "memory_items") {
        const memory = target ?? current;
        if (memory) affectedSubjects.add(`${memory.subject_kind}:${memory.subject_id}`);
      }
      if (target === null) deleteAuditedRow(db, change.table_name, key.id);
      else writeAuditedRow(db, change.table_name, target);
      const after = readAuditedRow(db, change.table_name, key.id);
      sequence += 1;
      recordAuditChange(
        db,
        rollbackEventId,
        sequence,
        change.table_name,
        key.id,
        current,
        after,
      );
    }
    db.prepare(
      "UPDATE audit_events SET rolled_back_by_event_id = ? WHERE id = ?",
    ).run(rollbackEventId, eventId);
    for (const subjectKey of affectedSubjects) {
      const subject = parseSubject(subjectKey);
      rebuildSearchSubject(db, subject.kind, subject.id);
    }
    return {
      rolled_back_event_id: eventId,
      rollback_event_id: rollbackEventId,
      affected_subjects: [...affectedSubjects],
      canonical_catalog_changed: false,
    };
  });
}

export function memoryStatus(db, dbPath = process.env.HA_MEMORY_DB ?? DEFAULT_MEMORY_DB) {
  const freshness = catalogFreshness(db);
  const counts = Object.fromEntries(
    ["pending", "verified", "applied", "rejected", "conflict", "superseded"].map(
      (status) => [
        status,
        db
          .prepare("SELECT COUNT(*) AS count FROM memory_items WHERE status = ?")
          .get(status).count,
      ],
    ),
  );
  const catalogCounts = Object.fromEntries(
    db
      .prepare(
        `SELECT kind, COUNT(*) AS count FROM catalog_objects
         WHERE active = 1 GROUP BY kind ORDER BY kind`,
      )
      .all()
      .map((row) => [row.kind, row.count]),
  );
  const lastSync = db
    .prepare("SELECT * FROM sync_runs ORDER BY id DESC LIMIT 1")
    .get();
  const lastSuccessful = db
    .prepare("SELECT * FROM sync_runs WHERE status = 'success' ORDER BY id DESC LIMIT 1")
    .get();
  const lastSuccessfulWarnings = lastSuccessful
    ? parseJsonColumn(lastSuccessful.warnings_json, [])
    : [];
  const fileMode = process.platform === "win32"
    ? null
    : (statSync(dbPath).mode & 0o777).toString(8).padStart(4, "0");
  return {
    schema_version: Number.parseInt(metadataGet(db, "schema_version"), 10),
    database_path: dbPath,
    database_mode: fileMode,
    integrity: db.prepare("PRAGMA quick_check").get()?.quick_check ?? "unknown",
    catalog_status: freshness.status,
    catalog_stored_status: freshness.stored_status,
    catalog_fresh: freshness.fresh,
    catalog_age_seconds: freshness.age_seconds,
    catalog_counts: catalogCounts,
    last_sync: lastSync
      ? {
          id: lastSync.id,
          status: lastSync.status,
          started_at: lastSync.started_at,
          completed_at: lastSync.completed_at,
          error_code: lastSync.error_code,
        }
      : null,
    last_successful_sync: lastSuccessful
      ? {
          id: lastSuccessful.id,
          completed_at: lastSuccessful.completed_at,
          ha_version: lastSuccessful.ha_version,
          object_count: lastSuccessful.object_count,
          relation_count: lastSuccessful.relation_count,
          warning_count: Array.isArray(lastSuccessfulWarnings)
            ? lastSuccessfulWarnings.length
            : 0,
        }
      : null,
    memory_counts: counts,
    open_conflicts: db
      .prepare("SELECT COUNT(*) AS count FROM conflicts WHERE status = 'open'")
      .get().count,
    pending_changes: db
      .prepare(
        "SELECT COUNT(*) AS count FROM change_records WHERE status IN ('pending', 'unavailable')",
      )
      .get().count,
  };
}
