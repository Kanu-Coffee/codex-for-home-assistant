import assert from "node:assert/strict";
import {
  chmod,
  copyFile,
  link,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";

const MODULE_ROOT = process.env.HA_MEMORY_INSTALLED_TEST === "1"
  ? "file:///usr/local/share/codex-ha"
  : new URL(
      "../codex_home_assistant/rootfs/usr/local/share/codex-ha/",
      import.meta.url,
    ).href.replace(/\/$/u, "");

const {
  addMemoryEvidence,
  applyMemoryCandidate,
  beginMemoryChange,
  closeMemoryDatabase,
  listMemoryConflicts,
  memoryHistory,
  memoryStatus,
  normalizeHomeAssistantSnapshot,
  openMemoryDatabase,
  proposeMemory,
  rejectMemoryCandidate,
  refreshMemory,
  resolveMemoryConflict,
  rollbackMemoryEvent,
  searchMemory,
  showMemorySubject,
  verifyMemoryCandidate,
  verifyMemoryChange,
} = await import(`${MODULE_ROOT}/ha-memory-core.mjs`);
const { executeMemoryCli } = await import(`${MODULE_ROOT}/ha-memory.mjs`);

const SOURCE_FIXTURE = process.env.HA_MEMORY_TEST_SOURCE_FIXTURE ?? fileURLToPath(
  new URL("./fixtures/ha_memory_snapshot.json", import.meta.url),
);

const RAW_SENTINELS = [
  "TRANSIENT_STATE_VALUE_4f91c0",
  "TRANSIENT_ATTRIBUTE_VALUE_8ca2d1",
  "TRANSIENT_LAST_CHANGED_3d77e2",
  "TRANSIENT_LAST_UPDATED_68b134",
  "TRANSIENT_SENSOR_SAMPLE_2b9a11",
  "TRANSIENT_LAST_TRIGGERED_f982ad",
  "AUTOMATION_RAW_ACTION_93f4b7",
];

const REJECTED_SENTINELS = [
  "sk-proj-REJECTEDMEMORYKEY123456789",
  "2026-07-15T12:34:56.000Z",
  "state=REJECTED_TRANSIENT_STATE",
  "User: REJECTED_RAW_CONVERSATION",
  "Evidence raw sentence must never persist",
];

async function sqliteBytes(dbPath) {
  const chunks = [];
  for (const suffix of ["", "-wal", "-shm"]) {
    const path = `${dbPath}${suffix}`;
    if (existsSync(path)) chunks.push(await readFile(path));
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function assertDatabaseExcludes(dbPath, values) {
  const contents = await sqliteBytes(dbPath);
  for (const value of values) {
    assert.equal(
      contents.includes(value),
      false,
      `SQLite files must not persist raw value ${value}`,
    );
  }
}

function asCoreSnapshot(fixture) {
  return {
    haVersion: fixture.ha_version,
    areas: fixture.areas,
    devices: fixture.devices,
    entities: fixture.entities,
    states: fixture.states,
    automations: fixture.automations,
    warnings: fixture.warnings,
  };
}

function propose(db, overrides) {
  return proposeMemory(db, {
    subject: "entity:light.kitchen_main",
    memoryType: "preference",
    key: "default_behavior",
    value: "fixture default",
    source: "user_explicit",
    sourceRef: "user-request:durable-preference",
    ...overrides,
  });
}

async function verifyRepeatedObservation(db, candidateId, detail) {
  addMemoryEvidence(db, candidateId, "observation", detail);
  return verifyMemoryCandidate(db, candidateId, "repeated_observation");
}

test("automation config fallback keeps direct references with exact provenance", () => {
  const normalized = normalizeHomeAssistantSnapshot({
    haVersion: "2026.7.2-test",
    areas: [],
    devices: [],
    entities: [{ entity_id: "automation.partial" }],
    states: [{
      entity_id: "automation.partial",
      state: "on",
      attributes: { friendly_name: "Partial fixture" },
    }],
    automations: {
      "automation.partial": {
        config: {
          alias: "Partial fixture",
          trigger: { area_id: "config_area" },
          condition: { device_id: "config_device" },
          action: {
            target: {
              entity_id: ["light.config_target", "light.related_target"],
            },
          },
        },
        related: { entity: ["light.related_target"] },
      },
    },
    warnings: ["automation_related_unavailable:automation.partial"],
  });

  for (const [kind, target] of [
    ["area", "config_area"],
    ["device", "config_device"],
    ["entity", "light.config_target"],
  ]) {
    const relation = normalized.relations.get(
      `automation:automation.partial|references|${kind}:${target}`,
    );
    assert.ok(relation);
    assert.deepEqual(JSON.parse(relation.metadata_json), {
      source: "automation_config",
    });
  }
  const relatedRelation = normalized.relations.get(
    "automation:automation.partial|references|entity:light.related_target",
  );
  assert.ok(relatedRelation);
  assert.deepEqual(JSON.parse(relatedRelation.metadata_json), {
    source: "search_related",
  });
  assert.deepEqual(normalized.warnings, [
    "automation_related_unavailable:automation.partial",
  ]);
});

test("validated Home Assistant memory lifecycle is durable, bounded, and fail-safe", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "ha-memory-runtime-"));
  const dbPath = join(directory, "memory.sqlite3");
  const fixturePath = join(directory, "ha-snapshot.json");
  const failureFixturePath = join(directory, "ha-failure.json");
  const previousEnvironment = {
    HA_MEMORY_DB: process.env.HA_MEMORY_DB,
    HA_MEMORY_TEST_FIXTURE: process.env.HA_MEMORY_TEST_FIXTURE,
    HA_MEMORY_TEST_MODE: process.env.HA_MEMORY_TEST_MODE,
  };
  let db = null;

  await copyFile(SOURCE_FIXTURE, fixturePath);
  await writeFile(failureFixturePath, JSON.stringify({ error: true }), "utf8");
  process.env.HA_MEMORY_DB = dbPath;
  process.env.HA_MEMORY_TEST_FIXTURE = fixturePath;
  process.env.HA_MEMORY_TEST_MODE = "1";

  t.after(async () => {
    if (db) closeMemoryDatabase(db, dbPath);
    for (const [key, value] of Object.entries(previousEnvironment)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(directory, { recursive: true, force: true });
  });

  // Cross the real CLI boundary for local initialization and the initial HA index.
  const initialized = await executeMemoryCli(["init", "--db", dbPath]);
  assert.equal(initialized.initialized, true);
  assert.equal(initialized.network_accessed, false);
  assert.equal(initialized.integrity, "ok");

  const initialRefresh = await executeMemoryCli([
    "refresh",
    "--db",
    dbPath,
    "--force",
  ]);
  assert.equal(initialRefresh.status, "success");
  assert.equal(initialRefresh.object_count, 9);
  assert.ok(initialRefresh.relation_count >= 9);

  db = openMemoryDatabase(dbPath);

  assert.throws(
    () =>
      propose(db, {
        memoryType: "note",
        key: "current_state",
        value: "on",
      }),
    (error) => error?.code === "transient_rejected",
  );
  assert.throws(
    () =>
      propose(db, {
        value: "password=MEMORY_TEST_SECRET_51aa0f",
      }),
    (error) => error?.code === "secret_rejected",
  );
  for (const value of [
    REJECTED_SENTINELS[0],
    `Durable note ${REJECTED_SENTINELS[1]}`,
    REJECTED_SENTINELS[2],
    `${REJECTED_SENTINELS[3]}\nAssistant: do not retain this`,
  ]) {
    assert.throws(
      () => propose(db, { memoryType: "note", key: "unsafe_payload", value }),
      (error) => [
        "secret_rejected",
        "transient_rejected",
        "conversation_rejected",
      ].includes(error?.code),
    );
  }
  assert.throws(
    () => propose(db, { value: "가".repeat(1400) }),
    (error) => error?.code === "invalid_value",
  );
  assert.throws(
    () => propose(db, { value: { desired: "durable" } }),
    (error) => error?.code === "invalid_value",
  );
  assert.throws(
    () => propose(db, { sourceRef: "raw provenance sentence is not a label" }),
    (error) => error?.code === "invalid_source_ref",
  );
  assert.throws(
    () => propose(db, { sourceRef: `user-request:${"a".repeat(190)}` }),
    (error) => error?.code === "invalid_source_ref",
  );
  assert.throws(
    () =>
      propose(db, {
        memoryType: "relationship",
        key: "closed_schema",
        value: {
          relation: "belongs_to",
          target: "device:dev_kitchen",
          transcript: "must reject",
        },
      }),
    (error) => error?.code === "invalid_relationship",
  );
  const evidenceLabelProbe = propose(db, {
    memoryType: "note",
    key: "evidence_label_probe",
    value: "Durable evidence label probe",
  });
  assert.throws(
    () => addMemoryEvidence(
      db,
      evidenceLabelProbe.candidate.id,
      "observation",
      REJECTED_SENTINELS[4],
    ),
    (error) => error?.code === "invalid_evidence",
  );
  assert.throws(
    () => rejectMemoryCandidate(
      db,
      evidenceLabelProbe.candidate.id,
      REJECTED_SENTINELS[2],
    ),
    (error) => error?.code === "transient_rejected",
  );
  rejectMemoryCandidate(
    db,
    evidenceLabelProbe.candidate.id,
    "Discard hardening probe safely",
  );
  const initialStatus = memoryStatus(db, dbPath);
  assert.equal(initialStatus.catalog_status, "ready");
  assert.equal(initialStatus.last_successful_sync.warning_count, 1);
  assert.equal(initialStatus.catalog_counts.area, 2);
  assert.equal(initialStatus.catalog_counts.device, 2);
  assert.equal(initialStatus.catalog_counts.entity, 4);
  assert.equal(initialStatus.catalog_counts.automation, 1);
  assert.ok(
    memoryHistory(db, {
      subject: "entity:light.kitchen_main",
      limit: 100,
    }).catalog_revisions.some((revision) =>
      revision.changed_fields.some((field) => field.startsWith("relationship:")),
    ),
  );

  // Disabled automations may exist only in the entity registry and still need indexing.
  const registryOnlyAutomationFixture = JSON.parse(
    await readFile(SOURCE_FIXTURE, "utf8"),
  );
  registryOnlyAutomationFixture.entities.push({
    entity_id: "automation.disabled_registry_only",
    name: "Disabled Registry Automation",
    platform: "automation",
    aliases: [],
    labels: [],
  });
  registryOnlyAutomationFixture.automations["automation.disabled_registry_only"] = {
    config: {
      id: "disabled_registry_only",
      alias: "Disabled Registry Automation",
      description: "A disabled automation with no current state row.",
      mode: "single",
    },
    related: {},
  };
  assert.equal(
    registryOnlyAutomationFixture.states.some(
      (state) => state.entity_id === "automation.disabled_registry_only",
    ),
    false,
  );
  await refreshMemory(db, {
    force: true,
    rawSnapshot: asCoreSnapshot(registryOnlyAutomationFixture),
  });
  assert.equal(
    showMemorySubject(db, "automation:automation.disabled_registry_only").canonical.name,
    "Disabled Registry Automation",
  );
  await refreshMemory(db, { force: true });

  const kitchenSearch = searchMemory(db, "Kitchen", { limit: 8 });
  assert.ok(kitchenSearch.result_count > 0);
  assert.ok(
    kitchenSearch.results.some((result) => result.subject === "area:kitchen"),
  );
  const light = showMemorySubject(db, "entity:light.kitchen_main");
  assert.equal(light.canonical.name, "Kitchen Main Light");
  assert.equal(light.canonical.attributes.area_id, "kitchen");
  assert.ok(
    light.relationships.outgoing.some(
      (relationship) =>
        relationship.relation === "belongs_to" &&
        relationship.target === "device:dev_kitchen",
    ),
  );

  closeMemoryDatabase(db, dbPath);
  db = null;
  await assertDatabaseExcludes(dbPath, [...RAW_SENTINELS, ...REJECTED_SENTINELS]);

  db = openMemoryDatabase(dbPath);

  // Candidates remain invisible until the pending -> verified -> applied path completes.
  const purpose = propose(db, {
    memoryType: "purpose",
    key: "meal_prep_role",
    value: "Illuminates the saffron meal prep counter",
  });
  assert.equal(purpose.candidate.status, "pending");
  assert.equal(searchMemory(db, "saffron", { limit: 8 }).result_count, 0);
  const purposeVerified = await verifyMemoryCandidate(
    db,
    purpose.candidate.id,
    "user_explicit",
  );
  assert.equal(purposeVerified.candidate.status, "verified");
  const purposeApplied = applyMemoryCandidate(db, purpose.candidate.id);
  assert.equal(purposeApplied.candidate.status, "applied");
  assert.ok(searchMemory(db, "saffron", { limit: 8 }).result_count > 0);

  // Observation and inference sources require two distinct observations.
  const observed = propose(db, {
    memoryType: "preference",
    key: "evening_scene",
    value: "Use a soft amber evening scene",
    source: "observation",
    sourceRef: "observation:evening-routine-1",
  });
  await assert.rejects(
    verifyMemoryCandidate(db, observed.candidate.id, "repeated_observation"),
    (error) => error?.code === "evidence_missing",
  );
  const observedVerified = await verifyRepeatedObservation(
    db,
    observed.candidate.id,
    "observation:evening-routine-2",
  );
  assert.equal(observedVerified.verified, true);
  assert.equal(applyMemoryCandidate(db, observed.candidate.id).result, "applied");

  // Stronger provenance for the same value creates a new candidate and replaces the weaker row.
  const provenanceInference = propose(db, {
    memoryType: "preference",
    key: "same_value_provenance",
    value: "Keep the durable provenance value",
    source: "inference",
    sourceRef: "inference:same-value",
  });
  addMemoryEvidence(
    db,
    provenanceInference.candidate.id,
    "observation",
    "observation:same-value-1",
  );
  await verifyRepeatedObservation(
    db,
    provenanceInference.candidate.id,
    "observation:same-value-2",
  );
  applyMemoryCandidate(db, provenanceInference.candidate.id);
  const provenanceExplicit = propose(db, {
    memoryType: "preference",
    key: "same_value_provenance",
    value: "Keep the durable provenance value",
    source: "user_explicit",
    sourceRef: "user-request:same-value",
  });
  assert.equal(provenanceExplicit.deduplicated, false);
  assert.notEqual(provenanceExplicit.candidate.id, provenanceInference.candidate.id);
  await verifyMemoryCandidate(db, provenanceExplicit.candidate.id, "user_explicit");
  assert.equal(
    applyMemoryCandidate(db, provenanceExplicit.candidate.id).result,
    "provenance_upgraded",
  );

  const rollbackEvidenceCandidate = propose(db, {
    memoryType: "note",
    key: "evidence_dependency_probe",
    value: "A repeated observation used only to test evidence rollback ordering",
    source: "inference",
    sourceRef: "inference:evidence-probe",
  });
  addMemoryEvidence(
    db,
    rollbackEvidenceCandidate.candidate.id,
    "observation",
    "observation:rollback-probe-1",
  );
  const secondEvidence = addMemoryEvidence(
    db,
    rollbackEvidenceCandidate.candidate.id,
    "observation",
    "observation:rollback-probe-2",
  );
  const evidenceVerification = await verifyMemoryCandidate(
    db,
    rollbackEvidenceCandidate.candidate.id,
    "repeated_observation",
  );
  assert.throws(
    () =>
      rollbackMemoryEvent(
        db,
        secondEvidence.audit_event_id,
        "Evidence cannot be removed after it was used for verification",
      ),
    (error) => error?.code === "rollback_dependency",
  );
  rollbackMemoryEvent(
    db,
    evidenceVerification.audit_event_id,
    "Return the candidate to pending before removing its evidence",
  );
  assert.equal(
    rollbackMemoryEvent(
      db,
      secondEvidence.audit_event_id,
      "Remove the now-unused second observation",
    ).rolled_back_event_id,
    secondEvidence.audit_event_id,
  );

  const parentDependency = propose(db, {
    memoryType: "note",
    key: "parent_dependency_probe",
    value: "Parent deletion must preserve later dependent evidence",
    source: "inference",
    sourceRef: "inference:parent-dependency",
  });
  addMemoryEvidence(
    db,
    parentDependency.candidate.id,
    "observation",
    "observation:parent-dependency-1",
  );
  assert.throws(
    () => rollbackMemoryEvent(
      db,
      parentDependency.audit_event_id,
      "Attempt unsafe parent deletion",
    ),
    (error) => error?.code === "rollback_dependency",
  );
  rejectMemoryCandidate(
    db,
    parentDependency.candidate.id,
    "Keep parent history and close probe",
  );

  // Higher-authority explicit direction replaces inference; lower authority conflicts.
  const inferred = propose(db, {
    memoryType: "preference",
    key: "startup_level",
    value: "Start at 30 percent",
    source: "inference",
    sourceRef: "inference:startup-level",
  });
  addMemoryEvidence(
    db,
    inferred.candidate.id,
    "observation",
    "observation:startup-30-1",
  );
  await verifyRepeatedObservation(
    db,
    inferred.candidate.id,
    "observation:startup-30-2",
  );
  assert.equal(applyMemoryCandidate(db, inferred.candidate.id).result, "applied");

  const explicit = propose(db, {
    memoryType: "preference",
    key: "startup_level",
    value: "Start at 65 percent",
    source: "user_explicit",
    sourceRef: "user-request:startup-level",
  });
  await verifyMemoryCandidate(db, explicit.candidate.id, "user_explicit");
  let explicitApplied = applyMemoryCandidate(db, explicit.candidate.id);
  assert.equal(explicitApplied.result, "superseded_lower_authority");
  assert.equal(explicitApplied.candidate.status, "applied");
  assert.ok(
    listMemoryConflicts(db, { status: "resolved" }).conflicts.some(
      (conflict) => conflict.reason === "higher_authority_candidate",
    ),
  );
  // The apply event inserts and resolves the same conflict row; rollback must coalesce it.
  rollbackMemoryEvent(
    db,
    explicitApplied.audit_event_id,
    "Exercise repeated row rollback simulation",
  );
  explicitApplied = applyMemoryCandidate(db, explicit.candidate.id);
  assert.equal(explicitApplied.candidate.status, "applied");

  const weakerDisagreement = propose(db, {
    memoryType: "preference",
    key: "startup_level",
    value: "Start at 10 percent",
    source: "observation",
    sourceRef: "observation:startup-10-1",
  });
  await verifyRepeatedObservation(
    db,
    weakerDisagreement.candidate.id,
    "observation:startup-10-2",
  );
  const weakerApplied = applyMemoryCandidate(db, weakerDisagreement.candidate.id);
  assert.equal(weakerApplied.result, "conflict");
  assert.equal(weakerApplied.candidate.status, "conflict");
  assert.ok(
    listMemoryConflicts(db, { status: "open" }).conflicts.some(
      (conflict) =>
        conflict.id === weakerApplied.conflict_id &&
        conflict.reason === "existing_memory_has_higher_authority",
    ),
  );
  assert.equal(searchMemory(db, "65 percent", { limit: 8 }).result_count, 0);
  assert.throws(
    () =>
      resolveMemoryConflict(
        db,
        weakerApplied.conflict_id,
        "ha",
        "Invalid noncanonical Home Assistant winner",
      ),
    (error) => error?.code === "invalid_winner",
  );
  rejectMemoryCandidate(
    db,
    weakerDisagreement.candidate.id,
    "Reject weaker conflicting observation",
  );
  assert.equal(
    listMemoryConflicts(db, { status: "open" }).conflicts.some(
      (conflict) => conflict.id === weakerApplied.conflict_id,
    ),
    false,
  );
  assert.ok(searchMemory(db, "65 percent", { limit: 8 }).result_count > 0);

  const wrongCanonicalRelationship = propose(db, {
    memoryType: "relationship",
    key: "wrong_device_link",
    value: { relation: "belongs_to", target: "device:dev_office" },
    source: "user_explicit",
    sourceRef: "user-request:structural-link-check",
  });
  const wrongCanonicalVerification = await verifyMemoryCandidate(
    db,
    wrongCanonicalRelationship.candidate.id,
    "ha_api",
  );
  assert.equal(wrongCanonicalVerification.verified, false);
  assert.equal(wrongCanonicalVerification.candidate.status, "conflict");
  assert.ok(Number.isInteger(wrongCanonicalVerification.conflict_id));
  resolveMemoryConflict(
    db,
    wrongCanonicalVerification.conflict_id,
    "ha",
    "Fresh Home Assistant registry structure is authoritative",
  );

  // Fresh post-change checks may inspect state, but store only check names and booleans.
  const contractProbeExpectations = {
    states: {
      "entity:light.kitchen_main": { state: "TRANSIENT_STATE_VALUE_4f91c0" },
    },
  };
  assert.throws(
    () => beginMemoryChange(
      db,
      "Reject an unknown expectation field",
      ["entity:light.kitchen_main"],
      { ...contractProbeExpectations, unknown: true },
    ),
    (error) => error?.code === "invalid_expectations",
  );
  assert.throws(
    () => beginMemoryChange(
      db,
      "Reject uncovered declared subjects",
      ["entity:light.kitchen_main", "entity:sensor.office_temperature"],
      contractProbeExpectations,
    ),
    (error) => error?.code === "expectation_subject_mismatch",
  );
  assert.throws(
    () => beginMemoryChange(
      db,
      "User: unsafe raw transcript summary",
      ["entity:light.kitchen_main"],
      contractProbeExpectations,
    ),
    (error) => error?.code === "conversation_rejected",
  );
  const contractProbe = beginMemoryChange(
    db,
    "Commit a stable post change expectation contract",
    ["entity:light.kitchen_main"],
    contractProbeExpectations,
  );
  assert.match(contractProbe.expectation_hash, /^[a-f0-9]{64}$/u);
  const contractRow = db
    .prepare(
      `SELECT expectation_hash, expectation_summary_json
       FROM change_records WHERE id = ?`,
    )
    .get(contractProbe.change_id);
  assert.equal(contractRow.expectation_hash, contractProbe.expectation_hash);
  assert.equal(
    contractRow.expectation_summary_json.includes("TRANSIENT_STATE_VALUE_4f91c0"),
    false,
  );
  await assert.rejects(
    verifyMemoryChange(db, contractProbe.change_id, {
      states: { "entity:light.kitchen_main": { state: "changed-contract" } },
    }),
    (error) => error?.code === "expectations_changed",
  );
  assert.equal(
    (await verifyMemoryChange(
      db,
      contractProbe.change_id,
      contractProbeExpectations,
    )).status,
    "verified",
  );

  const successfulExpectations = {
      objects: {
        "entity:light.kitchen_main": {
          exists: true,
          name: "Kitchen Main Light",
          area_id: "kitchen",
          device_id: "dev_kitchen"
        },
        "automation:automation.kitchen_motion_lights": {
          exists: true,
          name: "Kitchen Motion Lights",
        },
        "device:dev_kitchen": { exists: true },
      },
      relationships: [
        {
          source: "entity:light.kitchen_main",
          relation: "belongs_to",
          target: "device:dev_kitchen",
          exists: true,
        },
      ],
      states: {
        "entity:light.kitchen_main": {
          state: "TRANSIENT_STATE_VALUE_4f91c0",
          attributes: {
            effect: "TRANSIENT_ATTRIBUTE_VALUE_8ca2d1",
            brightness: 197,
          },
        },
      },
    };
  const successfulChange = beginMemoryChange(
    db,
    "Validate the kitchen light after applying its automation update",
    [
      "entity:light.kitchen_main",
      "automation:automation.kitchen_motion_lights",
      "device:dev_kitchen",
    ],
    successfulExpectations,
  );
  const successfulVerification = await verifyMemoryChange(
    db,
    successfulChange.change_id,
    successfulExpectations,
  );
  assert.equal(successfulVerification.status, "verified");
  assert.equal(successfulVerification.matched, true);
  assert.equal(successfulVerification.transient_values_persisted, false);
  assert.ok(successfulVerification.checks.every((check) => check.matched));
  assert.ok(
    successfulVerification.checks.every(
      (check) => !Object.hasOwn(check, "expected") && !Object.hasOwn(check, "actual"),
    ),
  );
  const changeCandidate = propose(db, {
    memoryType: "relationship",
    key: "verified_change_device_link",
    value: { relation: "belongs_to", target: "device:dev_kitchen" },
    source: "codex_change",
    sourceRef: "codex-change:kitchen-update",
  });
  assert.equal(
    (await verifyMemoryCandidate(
      db,
      changeCandidate.candidate.id,
      "change_verification",
      { changeId: successfulChange.change_id },
    )).verified,
    true,
  );

  const missingCheckCandidate = propose(db, {
    subject: "automation:automation.kitchen_motion_lights",
    memoryType: "relationship",
    key: "missing_change_fact_probe",
    value: { relation: "references", target: "entity:light.kitchen_main" },
    source: "codex_change",
    sourceRef: "codex-change:missing-check-probe",
  });
  await assert.rejects(
    verifyMemoryCandidate(
      db,
      missingCheckCandidate.candidate.id,
      "change_verification",
      { changeId: successfulChange.change_id },
    ),
    (error) => error?.code === "change_fact_mismatch",
  );

  const mismatchValue = "EXPECTED_STATE_MISMATCH_71c2fe";
  const mismatchExpectations = {
    states: {
      "entity:light.kitchen_main": { state: mismatchValue },
    },
  };
  const mismatchedChange = beginMemoryChange(
    db,
    "Detect a post-change state mismatch without retaining its raw value",
    ["entity:light.kitchen_main"],
    mismatchExpectations,
  );
  const mismatchVerification = await verifyMemoryChange(
    db,
    mismatchedChange.change_id,
    mismatchExpectations,
  );
  assert.equal(mismatchVerification.status, "mismatch");
  assert.equal(mismatchVerification.matched, false);
  assert.ok(Number.isInteger(mismatchVerification.conflict_id));
  assert.ok(
    listMemoryConflicts(db, { status: "open" }).conflicts.some(
      (conflict) => conflict.id === mismatchVerification.conflict_id,
    ),
  );
  resolveMemoryConflict(
    db,
    mismatchVerification.conflict_id,
    "ha",
    "Accept the freshly observed Home Assistant change result",
  );
  assert.equal(
    listMemoryConflicts(db, { status: "open" }).conflicts.some(
      (conflict) => conflict.id === mismatchVerification.conflict_id,
    ),
    false,
  );

  // A pre-change contract may name a subject that the mutation is expected to create.
  const creationExpectations = {
    objects: { "entity:light.new_fixture": { exists: true } },
  };
  const creationChange = beginMemoryChange(
    db,
    "Create a new fixture light entity",
    ["entity:light.new_fixture"],
    creationExpectations,
  );
  const creationVerification = await verifyMemoryChange(
    db,
    creationChange.change_id,
    creationExpectations,
  );
  assert.equal(creationVerification.status, "mismatch");
  resolveMemoryConflict(
    db,
    creationVerification.conflict_id,
    "ha",
    "Fresh Home Assistant confirms the entity was not created",
  );

  // Search rejects overlong queries and clamps count and serialized response size.
  assert.throws(
    () => searchMemory(db, "k".repeat(257), { limit: 8 }),
    (error) => error?.code === "invalid_query",
  );
  const bounded = searchMemory(db, "kitchen ".repeat(30), { limit: 999 });
  assert.equal(bounded.bounded.result_limit, 20);
  assert.equal(bounded.bounded.byte_limit, 32 * 1024);
  assert.ok(bounded.query.length <= 256);
  assert.ok(bounded.result_count <= 20);
  assert.ok(Buffer.byteLength(JSON.stringify(bounded), "utf8") <= 32 * 1024);
  assert.throws(
    () => searchMemory(db, "kitchen", { limit: "20oops" }),
    (error) => error?.code === "invalid_limit",
  );

  // Applied semantic memory has immutable history and a compensating rollback.
  const rollbackCandidate = propose(db, {
    memoryType: "note",
    key: "rollback_probe",
    value: "The cobalt rollback probe is durable only while applied",
    source: "user_explicit",
    sourceRef: "user-request:rollback-probe",
  });
  await verifyMemoryCandidate(db, rollbackCandidate.candidate.id, "user_explicit");
  const rollbackApplied = applyMemoryCandidate(db, rollbackCandidate.candidate.id);
  assert.ok(searchMemory(db, "cobalt", { limit: 8 }).result_count > 0);
  const beforeRollbackHistory = memoryHistory(db, {
    subject: "entity:light.kitchen_main",
    limit: 100,
  });
  assert.ok(
    beforeRollbackHistory.events.some(
      (event) =>
        event.id === rollbackApplied.audit_event_id && event.action === "memory_applied",
    ),
  );
  const rollback = rollbackMemoryEvent(
    db,
    rollbackApplied.audit_event_id,
    "Remove the reversible probe while preserving audit history",
  );
  assert.equal(rollback.rolled_back_event_id, rollbackApplied.audit_event_id);
  assert.equal(rollback.canonical_catalog_changed, false);
  assert.equal(searchMemory(db, "cobalt", { limit: 8 }).result_count, 0);
  assert.ok(
    memoryHistory(db, {
      subject: "entity:light.kitchen_main",
      limit: 100,
    }).events.some(
      (event) => event.id === rollback.rollback_event_id && event.action === "memory_rollback",
    ),
  );

  // Fresh HA structure is authoritative, and restored structure closes its conflict.
  const structural = propose(db, {
    memoryType: "relationship",
    key: "canonical_device_link",
    value: { relation: "belongs_to", target: "device:dev_kitchen" },
    source: "user_explicit",
    sourceRef: "user-request:canonical-link",
  });
  await verifyMemoryCandidate(db, structural.candidate.id, "ha_api");
  assert.equal(applyMemoryCandidate(db, structural.candidate.id).result, "applied");

  const modifiedFixture = JSON.parse(await readFile(fixturePath, "utf8"));
  const lightRegistryEntry = modifiedFixture.entities.find(
    (entity) => entity.entity_id === "light.kitchen_main",
  );
  lightRegistryEntry.device_id = null;
  await writeFile(fixturePath, JSON.stringify(modifiedFixture), "utf8");
  await refreshMemory(db, { force: true });
  let structuralConflict = listMemoryConflicts(db, { status: "open" }).conflicts.find(
    (conflict) =>
      conflict.existing_memory_id === structural.candidate.id &&
      conflict.reason === "ha_canonical_relationship_changed",
  );
  assert.ok(structuralConflict);

  await copyFile(SOURCE_FIXTURE, fixturePath);
  await refreshMemory(db, { force: true });
  assert.equal(
    listMemoryConflicts(db, { status: "open" }).conflicts.some(
      (conflict) => conflict.id === structuralConflict.id,
    ),
    false,
  );
  const catalogConflictHistory = memoryHistory(db, {
    subject: "entity:light.kitchen_main",
    limit: 100,
  }).events;
  assert.ok(
    catalogConflictHistory.some(
      (event) => event.action === "catalog_conflict_opened" && event.reversible === 0,
    ),
  );
  assert.ok(
    catalogConflictHistory.some(
      (event) => event.action === "catalog_conflict_resolved" && event.reversible === 0,
    ),
  );

  await writeFile(fixturePath, JSON.stringify(modifiedFixture), "utf8");
  await refreshMemory(db, { force: true });
  structuralConflict = listMemoryConflicts(db, { status: "open" }).conflicts.find(
    (conflict) =>
      conflict.existing_memory_id === structural.candidate.id &&
      conflict.reason === "ha_canonical_relationship_changed",
  );
  assert.ok(structuralConflict);
  assert.throws(
    () =>
      resolveMemoryConflict(
        db,
        structuralConflict.id,
        "existing",
        "Attempt to retain stale structural memory",
      ),
    (error) => error?.code === "invalid_winner",
  );
  lightRegistryEntry.device_id = "dev_office";
  await writeFile(fixturePath, JSON.stringify(modifiedFixture), "utf8");
  await refreshMemory(db, { force: true });
  const freshStructural = propose(db, {
    memoryType: "relationship",
    key: "fresh_canonical_device_link",
    value: { relation: "belongs_to", target: "device:dev_office" },
    source: "inference",
    sourceRef: "inference:fresh-canonical-link",
  });
  await verifyMemoryCandidate(db, freshStructural.candidate.id, "ha_api");
  assert.equal(
    applyMemoryCandidate(db, freshStructural.candidate.id).result,
    "superseded_lower_authority",
  );
  assert.equal(
    listMemoryConflicts(db, { status: "open" }).conflicts.some(
      (conflict) => conflict.id === structuralConflict.id,
    ),
    false,
  );
  assert.equal(
    showMemorySubject(db, "entity:light.kitchen_main").memories.some(
      (memory) => memory.key === "canonical_device_link",
    ),
    false,
  );
  assert.ok(
    showMemorySubject(db, "entity:light.kitchen_main").memories.some(
      (memory) => memory.key === "fresh_canonical_device_link",
    ),
  );

  // Malformed snapshots fail before replacing the last-known-good catalog.
  const malformedBefore = memoryStatus(db, dbPath).last_successful_sync.id;
  const malformedSnapshotFixture = JSON.parse(await readFile(fixturePath, "utf8"));
  const malformedSnapshot = {
    ...asCoreSnapshot(malformedSnapshotFixture),
    entities: [
      ...malformedSnapshotFixture.entities,
      malformedSnapshotFixture.entities[0],
    ],
  };
  await assert.rejects(
    refreshMemory(db, { force: true, rawSnapshot: malformedSnapshot }),
    (error) => error?.code === "invalid_snapshot",
  );
  assert.equal(memoryStatus(db, dbPath).last_successful_sync.id, malformedBefore);
  await refreshMemory(db, { force: true });

  // A late failure from an older refresh cannot downgrade a newer successful catalog.
  let releaseOlderRefresh;
  const delayedMalformedSnapshot = new Promise((resolve) => {
    releaseOlderRefresh = resolve;
  });
  const olderRefresh = refreshMemory(db, {
    force: true,
    rawSnapshot: delayedMalformedSnapshot,
  });
  const newerRefresh = await refreshMemory(db, {
    force: true,
    rawSnapshot: asCoreSnapshot(malformedSnapshotFixture),
  });
  releaseOlderRefresh({});
  await assert.rejects(
    olderRefresh,
    (error) => error?.code === "invalid_snapshot",
  );
  const raceStatus = memoryStatus(db, dbPath);
  assert.equal(raceStatus.catalog_status, "ready");
  assert.equal(raceStatus.last_successful_sync.id, newerRefresh.sync_id);

  // Freshness is computed from the successful timestamp, not a sticky metadata label.
  const currentVerifiedAt = db
    .prepare("SELECT value FROM metadata WHERE key = 'last_successful_sync_at'")
    .get().value;
  db.prepare(
    "UPDATE metadata SET value = '2000-01-01T00:00:00.000Z' WHERE key = 'last_successful_sync_at'",
  ).run();
  assert.equal(memoryStatus(db, dbPath).catalog_status, "stale");
  assert.equal(memoryStatus(db, dbPath).catalog_fresh, false);
  assert.equal(searchMemory(db, "kitchen").catalog.stale, true);
  db.prepare("UPDATE metadata SET value = ? WHERE key = 'last_successful_sync_at'").run(
    currentVerifiedAt,
  );

  const beforeFailure = memoryStatus(db, dbPath);
  const canonicalBeforeFailure = showMemorySubject(
    db,
    "entity:light.kitchen_main",
  ).canonical;
  process.env.HA_MEMORY_TEST_FIXTURE = failureFixturePath;
  await assert.rejects(
    refreshMemory(db, { force: true }),
    /fixture requested an API failure/u,
  );
  const afterFailure = memoryStatus(db, dbPath);
  assert.equal(afterFailure.catalog_status, "stale");
  assert.equal(
    afterFailure.last_successful_sync.id,
    beforeFailure.last_successful_sync.id,
  );
  assert.deepEqual(
    showMemorySubject(db, "entity:light.kitchen_main").canonical,
    canonicalBeforeFailure,
  );
  assert.equal(afterFailure.last_sync.status, "failed");
  assert.equal(afterFailure.last_sync.error_code, "ha_fixture_failure");

  closeMemoryDatabase(db, dbPath);
  db = null;
  await assertDatabaseExcludes(dbPath, [
    ...RAW_SENTINELS,
    ...REJECTED_SENTINELS,
    mismatchValue,
  ]);

  if (process.platform !== "win32") {
    const storageDirectory = await mkdtemp(join(directory, "storage-policy-"));
    const storageDbPath = join(storageDirectory, "memory.sqlite3");
    const storageDb = openMemoryDatabase(storageDbPath);
    closeMemoryDatabase(storageDb, storageDbPath);

    await chmod(storageDbPath, 0o644);
    assert.throws(
      () => openMemoryDatabase(storageDbPath),
      (error) => error?.code === "unsafe_storage",
    );
    await chmod(storageDbPath, 0o600);

    const extraLink = join(storageDirectory, "extra-link.sqlite3");
    await link(storageDbPath, extraLink);
    assert.throws(
      () => openMemoryDatabase(storageDbPath),
      (error) => error?.code === "unsafe_storage",
    );
    await rm(extraLink);

    const symbolicPath = join(storageDirectory, "symbolic.sqlite3");
    await symlink(storageDbPath, symbolicPath);
    assert.throws(
      () => openMemoryDatabase(symbolicPath),
      (error) => error?.code === "unsafe_storage",
    );
    await rm(symbolicPath);

    const brokenTarget = join(storageDirectory, "broken-target.sqlite3");
    const brokenSymbolicPath = join(storageDirectory, "broken-symbolic.sqlite3");
    await symlink(brokenTarget, brokenSymbolicPath);
    assert.throws(
      () => openMemoryDatabase(brokenSymbolicPath),
      (error) => error?.code === "unsafe_storage",
    );
    assert.equal(existsSync(brokenTarget), false);
    await rm(brokenSymbolicPath);

    const auxiliaryTarget = join(storageDirectory, "auxiliary-target");
    await writeFile(auxiliaryTarget, "must not be followed", { mode: 0o600 });
    const maliciousWal = `${storageDbPath}-wal`;
    await symlink(auxiliaryTarget, maliciousWal);
    assert.throws(
      () => openMemoryDatabase(storageDbPath),
      (error) => error?.code === "unsafe_storage",
    );
    await rm(maliciousWal);

    const brokenWalTarget = join(storageDirectory, "broken-wal-target");
    await symlink(brokenWalTarget, maliciousWal);
    assert.throws(
      () => openMemoryDatabase(storageDbPath),
      (error) => error?.code === "unsafe_storage",
    );
    assert.equal(existsSync(brokenWalTarget), false);
    await rm(maliciousWal);
  }
});

test("existing database schema preflight is fail-closed and read-only", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "ha-memory-schema-"));
  t.after(() => rm(directory, { recursive: true, force: true }));

  const cases = [
    {
      name: "missing-version.sqlite3",
      setup(db) {
        db.exec("CREATE TABLE metadata(key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT");
      },
      code: "invalid_schema",
    },
    {
      name: "partial-v1.sqlite3",
      setup(db) {
        db.exec("CREATE TABLE metadata(key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT");
        db.prepare("INSERT INTO metadata(key, value) VALUES('schema_version', '1')").run();
      },
      code: "invalid_schema",
    },
    {
      name: "old-version.sqlite3",
      setup(db) {
        db.exec("CREATE TABLE metadata(key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT");
        db.prepare("INSERT INTO metadata(key, value) VALUES('schema_version', '0')").run();
      },
      code: "migration_required",
    },
  ];

  for (const item of cases) {
    const path = join(directory, item.name);
    const malformed = new DatabaseSync(path);
    item.setup(malformed);
    malformed.close();
    const before = await readFile(path);
    assert.throws(
      () => openMemoryDatabase(path),
      (error) => error?.code === item.code,
    );
    const after = await readFile(path);
    assert.deepEqual(after, before, `${item.name} must not be mutated during preflight`);
  }
});
