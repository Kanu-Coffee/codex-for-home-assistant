import functools
import hashlib
import http.server
import io
import shutil
import json
import os
import subprocess
import sys
import tarfile
import threading
import time
from pathlib import Path
import pytest


@pytest.fixture(autouse=True)
def private_package_umask():
    previous = os.umask(0o022)
    try:
        yield
    finally:
        os.umask(previous)


def run_node_eval(script: str, cwd: Path) -> dict:
    code = f"""
    import * as mgr from './codex_home_assistant/rootfs/usr/local/share/codex-ha/codex-runtime-manager.mjs';
    async function sealFixture(root, digest = 'b'.repeat(64)) {{
      const ledger = await import('./codex_home_assistant/rootfs/usr/local/share/codex-ha/codex-package-integrity.mjs');
      await ledger.recordPackage(root, mgr.getBaseRuntimeDir(), digest, await ledger.packageInventory(root));
      const manifest = JSON.parse(await (await import('node:fs/promises')).readFile(root + '/codex-package.json', 'utf8'));
      await mgr.updateState(s => {{ s.candidateVersion = manifest.version; s.candidateDigest = digest; }});
    }}
    {script}
    """
    proc = subprocess.run(
        ["node", "--input-type=module", "-e", code],
        cwd=cwd,
        capture_output=True,
        text=True,
    )
    if proc.returncode != 0:
        raise RuntimeError(f"Node execution failed (code {proc.returncode}):\n{proc.stderr}\n{proc.stdout}")
    return json.loads(proc.stdout.strip()) if proc.stdout.strip() else {}


def test_addon_config_declares_auto_update_options(addon_config: dict) -> None:
    options = addon_config.get("options", {})
    schema = addon_config.get("schema", {})

    assert options.get("codex_auto_update") is True
    assert options.get("codex_auto_update_timezone") == "Asia/Seoul"
    assert schema.get("codex_auto_update") == "bool"
    assert schema.get("codex_auto_update_timezone") == "str"


def test_translations_cover_auto_update_options(addon_root: Path) -> None:
    import yaml

    en = yaml.safe_load((addon_root / "translations/en.yaml").read_text(encoding="utf-8"))
    ko = yaml.safe_load((addon_root / "translations/ko.yaml").read_text(encoding="utf-8"))

    for config in (en, ko):
        conf = config.get("configuration", {})
        assert "codex_auto_update" in conf
        assert "codex_auto_update_timezone" in conf
        assert "name" in conf["codex_auto_update"]
        assert "description" in conf["codex_auto_update"]
        assert "name" in conf["codex_auto_update_timezone"]
        assert "description" in conf["codex_auto_update_timezone"]


def test_timezone_and_slot_calculations(repository_root: Path) -> None:
    script = """
    const tzValid = mgr.isValidTimezone('Asia/Seoul') && mgr.isValidTimezone('UTC') && !mgr.isValidTimezone('Mars/Olympus');
    
    // Test 10:15 KST -> active slot is 09:00
    const d1 = new Date('2026-10-13T10:15:00+09:00');
    const s1 = mgr.getCurrentSlotInfo(d1, 'Asia/Seoul');
    
    // Test 02:30 KST -> active slot is 21:00 on previous day
    const d2 = new Date('2026-10-13T02:30:00+09:00');
    const s2 = mgr.getCurrentSlotInfo(d2, 'Asia/Seoul');

    // Test 15:00 KST exact -> active slot is 15:00
    const d3 = new Date('2026-10-13T15:00:00+09:00');
    const s3 = mgr.getCurrentSlotInfo(d3, 'Asia/Seoul');

    // Test America/New_York DST Spring forward: 2026-03-08T01:30:00-05:00 (06:30Z)
    // Next 03:00 local is 03:00 EDT = 07:00Z (exactly 30 minutes later!)
    const dSpring = new Date('2026-03-08T06:30:00Z');
    const sSpring = mgr.getCurrentSlotInfo(dSpring, 'America/New_York');
    const nextDaySpring = mgr.getNextDayFirstSlotTime(dSpring, 'America/New_York');

    // Test America/New_York DST Fall back: 2026-11-01T00:30:00-04:00 (04:30Z)
    // Next 03:00 local is 03:00 EST = 08:00Z (exactly 210 minutes later!)
    const dFall = new Date('2026-11-01T04:30:00Z');
    const sFall = mgr.getCurrentSlotInfo(dFall, 'America/New_York');

    // Pacific/Auckland: 2026-10-13T22:00:00+13:00 (09:00Z) -> hour 22 >= 21
    // slotDate must be 2026-10-13, slotKey 2026-10-13T21:00, nextSlot is 10/14 03:00 = 14:00Z
    const dAuckLate = new Date('2026-10-13T09:00:00Z');
    const sAuckLate = mgr.getCurrentSlotInfo(dAuckLate, 'Pacific/Auckland');
    const nextDayAuck = mgr.getNextDayFirstSlotTime(dAuckLate, 'Pacific/Auckland');

    // Pacific/Auckland: 2026-10-13T01:00:00+13:00 (12:00Z on 10/12) -> hour 1 < 3
    // slotDate must be 2026-10-12, slotKey 2026-10-12T21:00, nextSlot is 10/13 03:00 = 14:00Z on 10/12
    const dAuckEarly = new Date('2026-10-12T12:00:00Z');
    const sAuckEarly = mgr.getCurrentSlotInfo(dAuckEarly, 'Pacific/Auckland');

    // Pacific/Kiritimati (UTC+14): 2026-10-13T23:30:00+14:00 (09:30Z)
    const dKiriLate = new Date('2026-10-13T09:30:00Z');
    const sKiriLate = mgr.getCurrentSlotInfo(dKiriLate, 'Pacific/Kiritimati');
    const nextDayKiri = mgr.getNextDayFirstSlotTime(dKiriLate, 'Pacific/Kiritimati');

    // Pacific/Kiritimati: 2026-10-13T01:30:00+14:00 (11:30Z on 10/12)
    const dKiriEarly = new Date('2026-10-12T11:30:00Z');
    const sKiriEarly = mgr.getCurrentSlotInfo(dKiriEarly, 'Pacific/Kiritimati');

    // Etc/GMT+12 (UTC-12): 2026-10-13T01:00:00-12:00 (13:00Z on 10/13)
    const dGmt12Early = new Date('2026-10-13T13:00:00Z');
    const sGmt12Early = mgr.getCurrentSlotInfo(dGmt12Early, 'Etc/GMT+12');

    // Year rollover: 2026-12-31T23:00:00+09:00 (14:00Z)
    const dYearEnd = new Date('2026-12-31T14:00:00Z');
    const sYearEnd = mgr.getCurrentSlotInfo(dYearEnd, 'Asia/Seoul');
    const nextDayYearEnd = mgr.getNextDayFirstSlotTime(dYearEnd, 'Asia/Seoul');

    // Year start: 2027-01-01T01:00:00+09:00 (16:00Z on 12/31)
    const dYearStart = new Date('2026-12-31T16:00:00Z');
    const sYearStart = mgr.getCurrentSlotInfo(dYearStart, 'Asia/Seoul');

    console.log(JSON.stringify({
      tzValid,
      s1: { activeSlotHour: s1.activeSlotHour, slotKey: s1.slotKey, msUntilNextSlot: s1.msUntilNextSlot },
      s2: { activeSlotHour: s2.activeSlotHour, slotKey: s2.slotKey, msUntilNextSlot: s2.msUntilNextSlot },
      s3: { activeSlotHour: s3.activeSlotHour, slotKey: s3.slotKey, msUntilNextSlot: s3.msUntilNextSlot },
      sSpring: { msUntilNextSlot: sSpring.msUntilNextSlot, nextDayFirstSlot: nextDaySpring.toISOString() },
      sFall: { msUntilNextSlot: sFall.msUntilNextSlot },
      sAuckLate: { slotKey: sAuckLate.slotKey, nextSlot: sAuckLate.nextSlotTime.toISOString(), nextDay: nextDayAuck.toISOString() },
      sAuckEarly: { slotKey: sAuckEarly.slotKey, nextSlot: sAuckEarly.nextSlotTime.toISOString() },
      sKiriLate: { slotKey: sKiriLate.slotKey, nextSlot: sKiriLate.nextSlotTime.toISOString(), nextDay: nextDayKiri.toISOString() },
      sKiriEarly: { slotKey: sKiriEarly.slotKey, nextSlot: sKiriEarly.nextSlotTime.toISOString() },
      sGmt12Early: { slotKey: sGmt12Early.slotKey, nextSlot: sGmt12Early.nextSlotTime.toISOString() },
      sYearEnd: { slotKey: sYearEnd.slotKey, nextSlot: sYearEnd.nextSlotTime.toISOString(), nextDay: nextDayYearEnd.toISOString() },
      sYearStart: { slotKey: sYearStart.slotKey, nextSlot: sYearStart.nextSlotTime.toISOString() }
    }));
    """
    res = run_node_eval(script, repository_root)
    assert res["tzValid"] is True
    assert res["s1"]["activeSlotHour"] == 9
    assert res["s1"]["slotKey"] == "2026-10-13T09:00"
    assert res["s1"]["msUntilNextSlot"] > 0

    assert res["s2"]["activeSlotHour"] == 21
    assert res["s2"]["slotKey"] == "2026-10-12T21:00"
    assert res["s2"]["msUntilNextSlot"] > 0

    assert res["s3"]["activeSlotHour"] == 15
    assert res["s3"]["slotKey"] == "2026-10-13T15:00"

    # Spring forward: 01:30 to 03:00 EDT is exactly 30 minutes (07:00Z)
    assert res["sSpring"]["msUntilNextSlot"] == 30 * 60 * 1000
    assert res["sSpring"]["nextDayFirstSlot"] == "2026-03-08T07:00:00.000Z"

    # Fall back: 00:30 EDT to 03:00 EST is exactly 210 minutes (08:00Z)
    assert res["sFall"]["msUntilNextSlot"] == 210 * 60 * 1000

    # Auckland late (22:00 local): next 03:00 is 10/14 local = 10/13 14:00Z
    assert res["sAuckLate"]["slotKey"] == "2026-10-13T21:00"
    assert res["sAuckLate"]["nextSlot"] == "2026-10-13T14:00:00.000Z"
    assert res["sAuckLate"]["nextDay"] == "2026-10-13T14:00:00.000Z"

    # Auckland early (01:00 local): active slot is yesterday 21:00 = 10/12T21:00
    assert res["sAuckEarly"]["slotKey"] == "2026-10-12T21:00"
    assert res["sAuckEarly"]["nextSlot"] == "2026-10-12T14:00:00.000Z"

    # Kiritimati late (UTC+14): next 03:00 is 10/14 03:00 = 10/13 13:00Z
    assert res["sKiriLate"]["slotKey"] == "2026-10-13T21:00"
    assert res["sKiriLate"]["nextSlot"] == "2026-10-13T13:00:00.000Z"
    assert res["sKiriLate"]["nextDay"] == "2026-10-13T13:00:00.000Z"

    # Kiritimati early (UTC+14): active slot is yesterday 21:00 = 10/12T21:00
    assert res["sKiriEarly"]["slotKey"] == "2026-10-12T21:00"
    assert res["sKiriEarly"]["nextSlot"] == "2026-10-12T13:00:00.000Z"

    # Etc/GMT+12 (UTC-12): early 01:00 local is active slot yesterday 21:00 = 10/12T21:00
    assert res["sGmt12Early"]["slotKey"] == "2026-10-12T21:00"
    assert res["sGmt12Early"]["nextSlot"] == "2026-10-13T15:00:00.000Z"

    # Year rollover: 2026-12-31 23:00 KST -> next slot 2027-01-01 03:00 KST = 2026-12-31T18:00Z
    assert res["sYearEnd"]["slotKey"] == "2026-12-31T21:00"
    assert res["sYearEnd"]["nextSlot"] == "2026-12-31T18:00:00.000Z"
    assert res["sYearEnd"]["nextDay"] == "2026-12-31T18:00:00.000Z"

    # Year start: 2027-01-01 01:00 KST -> active slot is 2026-12-31T21:00
    assert res["sYearStart"]["slotKey"] == "2026-12-31T21:00"
    assert res["sYearStart"]["nextSlot"] == "2026-12-31T18:00:00.000Z"


def test_semver_comparisons(repository_root: Path) -> None:
    script = """
    console.log(JSON.stringify({
      gt: mgr.compareSemver('0.162.1', '0.144.1'),
      lt: mgr.compareSemver('0.144.1', '0.162.1'),
      eq: mgr.compareSemver('0.162.1', '0.162.1'),
      invalid: mgr.parseSemver('0.162.1-beta')
    }));
    """
    res = run_node_eval(script, repository_root)
    assert res["gt"] == 1
    assert res["lt"] == -1
    assert res["eq"] == 0
    assert res["invalid"] is None


def test_target_architecture_resolution(repository_root: Path) -> None:
    script = """
    console.log(JSON.stringify({
      x64: mgr.resolveTargetArchitecture('x64'),
      x86_64: mgr.resolveTargetArchitecture('x86_64'),
      arm64: mgr.resolveTargetArchitecture('arm64'),
      aarch64: mgr.resolveTargetArchitecture('aarch64')
    }));
    """
    res = run_node_eval(script, repository_root)
    assert res["x64"] == "x86_64-unknown-linux-musl"
    assert res["x86_64"] == "x86_64-unknown-linux-musl"
    assert res["arm64"] == "aarch64-unknown-linux-musl"
    assert res["aarch64"] == "aarch64-unknown-linux-musl"


def test_options_validation_fail_closed(repository_root: Path, tmp_path: Path) -> None:
    opt_file = tmp_path / "options.json"
    
    # 1. Missing file: default ON, valid
    script_missing = f"""
    process.env.CODEX_HA_OPTIONS_FILE = '{opt_file}';
    console.log(JSON.stringify(await mgr.readOptions()));
    """
    res = run_node_eval(script_missing, repository_root)
    assert res["autoUpdate"] is True
    assert res["valid"] is True

    # 2. Malformed JSON: fail closed (autoUpdate: false, valid: false)
    opt_file.write_text("{{malformed json", encoding="utf-8")
    script_malformed = f"""
    process.env.CODEX_HA_OPTIONS_FILE = '{opt_file}';
    console.log(JSON.stringify(await mgr.readOptions()));
    """
    res = run_node_eval(script_malformed, repository_root)
    assert res["autoUpdate"] is False
    assert res["valid"] is False
    assert "error" in res

    # 3. Non-boolean codex_auto_update: fail closed
    opt_file.write_text(json.dumps({"codex_auto_update": "yes"}), encoding="utf-8")
    res = run_node_eval(script_malformed, repository_root)
    assert res["autoUpdate"] is False
    assert res["valid"] is False

    # 4. Invalid timezone: fail closed
    opt_file.write_text(json.dumps({"codex_auto_update": True, "codex_auto_update_timezone": "Moon/Base"}), encoding="utf-8")
    res = run_node_eval(script_malformed, repository_root)
    assert res["autoUpdate"] is False
    assert res["valid"] is False

    # 5. Valid options: success
    opt_file.write_text(json.dumps({"codex_auto_update": False, "codex_auto_update_timezone": "UTC"}), encoding="utf-8")
    res = run_node_eval(script_malformed, repository_root)
    assert res["autoUpdate"] is False
    assert res["timezone"] == "UTC"
    assert res["valid"] is True


def test_session_inspection_and_admission_safety(repository_root: Path, tmp_path: Path) -> None:
    runtime_dir = tmp_path / "runtime"
    maint_dir = tmp_path / "maint"
    sessions_dir = maint_dir / "sessions"
    sessions_dir.mkdir(parents=True)

    pid = os.getpid()
    stat_parts = Path(f"/proc/{pid}/stat").read_text().rsplit(")", 1)[1].split()
    start_time = stat_parts[19]
    session_file = sessions_dir / str(pid)
    session_file.write_text(json.dumps({"pid": pid, "start": start_time, "type": "cli"}))

    dead_session_file = sessions_dir / "99999999"
    dead_session_file.write_text(json.dumps({"pid": 99999999, "start": "0", "type": "cli"}))

    script = f"""
    process.env.CODEX_RUNTIME_DIR = '{runtime_dir}';
    process.env.CODEX_MAINTENANCE_DIR = '{maint_dir}';
    const res = await mgr.inspectAllSessions();
    console.log(JSON.stringify(res));
    """
    res = run_node_eval(script, repository_root)
    assert res["isIdle"] is False
    assert res["sessionCount"] >= 1
    assert any(f"pid {pid}" in reason for reason in res["busyReasons"])
    assert not dead_session_file.exists()


def test_status_output_scrubs_secrets_and_reports_honest_versions(
    repository_root: Path, tmp_path: Path
) -> None:
    runtime_dir = tmp_path / "runtime"
    maint_dir = tmp_path / "maint"
    runtime_dir.mkdir()
    maint_dir.mkdir()

    baseline_dir = tmp_path / "baseline"
    baseline_dir.mkdir()
    (baseline_dir / "codex-package.json").write_text(
        json.dumps({
            "version": "0.162.1",
            "target": "x86_64-unknown-linux-musl",
            "entrypoint": "bin/codex",
        }),
        encoding="utf-8",
    )
    (baseline_dir / "bin").mkdir()
    (baseline_dir / "bin" / "codex").write_text("#!/bin/sh\nexit 0\n")
    (baseline_dir / "bin" / "codex").chmod(0o755)

    script = f"""
    process.env.CODEX_BASELINE_DIR = '{baseline_dir}';
    process.env.CODEX_RUNTIME_DIR = '{runtime_dir}';
    process.env.CODEX_MAINTENANCE_DIR = '{maint_dir}';
    process.env.SUPERVISOR_TOKEN = 'secret-token-should-not-leak';
    await mgr.initRuntime();
    const status = await mgr.getStatus();
    console.log(JSON.stringify(status));
    """
    status = run_node_eval(script, repository_root)
    assert status["appVersion"] == "0.7.2-dev.2"
    assert status["bundledVersion"] == "0.162.1"
    assert status["selectedVersion"] == "0.162.1"
    assert status["runningVersion"] in ("none", "0.162.1")
    assert isinstance(status["runningVersions"], list)
    assert "secret-token-should-not-leak" not in json.dumps(status)


def test_gate_locking_contention(repository_root: Path, tmp_path: Path) -> None:
    maint_dir = tmp_path / "maint"
    maint_dir.mkdir(parents=True)

    script = f"""
    process.env.CODEX_MAINTENANCE_DIR = '{maint_dir}';

    let contentionFailed = false;
    let contentionError = '';
    const p1 = mgr.withGateLock('exclusive', 5, async () => {{
      await new Promise(r => setTimeout(r, 1000));
      return 'done1';
    }});

    await new Promise(r => setTimeout(r, 100));

    try {{
      // Try to acquire exclusive lock with 0.2s timeout while p1 holds lock -> must timeout
      await mgr.withGateLock('exclusive', 0.2, async () => {{
        return 'done2';
      }});
    }} catch (err) {{
      contentionFailed = true;
      contentionError = err.message;
    }}

    const res1 = await p1;
    console.log(JSON.stringify({{ res1, contentionFailed, contentionError }}));
    """
    res = run_node_eval(script, repository_root)
    assert res["res1"] == "done1"
    assert res["contentionFailed"] is True
    assert "Timeout" in res["contentionError"]


def test_gate_locking_fails_closed_without_flock(repository_root: Path, tmp_path: Path) -> None:
    maint_dir = tmp_path / "maint"
    maint_dir.mkdir(parents=True)

    script = f"""
    process.env.CODEX_MAINTENANCE_DIR = '{maint_dir}';
    process.env.PATH = '/non_existent_bin_path';

    let failed = false;
    let ran = false;
    let errorMsg = '';
    try {{
      await mgr.withGateLock('exclusive', 2, async () => {{
        ran = true;
      }});
    }} catch (err) {{
      failed = true;
      errorMsg = err.message;
    }}

    console.log(JSON.stringify({{ failed, ran, errorMsg }}));
    """
    res = run_node_eval(script, repository_root)
    assert res["failed"] is True
    assert res["ran"] is False
    assert "flock utility is not available" in res["errorMsg"]


def test_stale_state_overwrite_prevention(repository_root: Path, tmp_path: Path) -> None:
    runtime_dir = tmp_path / "runtime"
    maint_dir = tmp_path / "maint"
    runtime_dir.mkdir(parents=True)
    maint_dir.mkdir(parents=True)

    script = f"""
    process.env.CODEX_RUNTIME_DIR = '{runtime_dir}';
    process.env.CODEX_MAINTENANCE_DIR = '{maint_dir}';
    
    await mgr.initRuntime();
    
    // Simulate checkUpdate setting stagedVersion
    await mgr.updateState((s) => {{
      s.stagedVersion = '0.163.0';
      s.status = 'ready_to_apply';
    }});

    // Now daemon reads state, updates lastCheckSlot concurrently
    await mgr.updateState((s) => {{
      s.lastCheckSlot = '2026-10-13T09:00';
    }});

    const state = await mgr.loadState();
    console.log(JSON.stringify(state));
    """
    state = run_node_eval(script, repository_root)
    assert state["stagedVersion"] == "0.163.0"
    assert state["lastCheckSlot"] == "2026-10-13T09:00"
    assert state["status"] == "ready_to_apply"


def test_candidate_retry_caps_and_digest_mismatch(repository_root: Path, tmp_path: Path) -> None:
    runtime_dir = tmp_path / "runtime"
    maint_dir = tmp_path / "maint"
    runtime_dir.mkdir(parents=True)
    maint_dir.mkdir(parents=True)

    # Test candidate digest mismatch rejection
    script_mismatch = f"""
    process.env.CODEX_RUNTIME_DIR = '{runtime_dir}';
    process.env.CODEX_MAINTENANCE_DIR = '{maint_dir}';

    await mgr.initRuntime();
    await mgr.updateState((s) => {{
      s.candidateVersion = '0.163.0';
      s.candidateDigest = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    }});

    const fixtureRelease = {{
      tag_name: 'rust-v0.163.0',
      assets: [{{
        name: 'codex-package-x86_64-unknown-linux-musl.tar.gz',
        digest: 'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      }}]
    }};

    const res = await mgr.checkUpdate(null, {{ fixtureRelease }});
    console.log(JSON.stringify(res));
    """
    res = run_node_eval(script_mismatch, repository_root)
    assert res["blocked"] is True
    assert res["blockedReason"] == "candidate_digest_mismatch"
    assert res["state"]["status"] == "failed"


def test_daily_idle_budget_pause_and_next_day_recovery(repository_root: Path, tmp_path: Path) -> None:
    runtime_dir = tmp_path / "runtime"
    maint_dir = tmp_path / "maint"
    sessions_dir = maint_dir / "sessions"
    sessions_dir.mkdir(parents=True)
    runtime_dir.mkdir(parents=True)

    # Register an active dummy session
    pid = os.getpid()
    stat_parts = Path(f"/proc/{pid}/stat").read_text().rsplit(")", 1)[1].split()
    start_time = stat_parts[19]
    (sessions_dir / str(pid)).write_text(
        json.dumps({"pid": pid, "start": start_time, "type": "cli"}),
        encoding="utf-8",
    )
    options_file = tmp_path / "options.json"
    options_file.write_text(json.dumps({"codex_auto_update_timezone": "UTC"}), encoding="utf-8")

    script = f"""
    process.env.CODEX_RUNTIME_DIR = '{runtime_dir}';
    process.env.CODEX_MAINTENANCE_DIR = '{maint_dir}';
    process.env.CODEX_HA_OPTIONS_FILE = '{options_file}';
    process.env.CODEX_TEST_CLOCK = '2026-10-13T10:00:00Z';

    await mgr.initRuntime();

    // Create a mock staged release
    const releasesDir = mgr.getReleasesDir();
    const candidateDir = releasesDir + '/0.163.0-x86_64-unknown-linux-musl';
    await (await import('node:fs/promises')).mkdir(candidateDir + '/bin', {{ recursive: true }});
    await (await import('node:fs/promises')).writeFile(candidateDir + '/bin/codex', '#!/bin/sh\\necho codex-cli 0.163.0\\n');
    await (await import('node:fs/promises')).chmod(candidateDir + '/bin/codex', 0o755);
    await (await import('node:fs/promises')).writeFile(
      candidateDir + '/codex-package.json',
      JSON.stringify({{ version: '0.163.0', target: 'x86_64-unknown-linux-musl', entrypoint: 'bin/codex' }})
    );
    await sealFixture(candidateDir);
    await (await import('node:fs/promises')).symlink(candidateDir, mgr.getStagedLink());

    await mgr.updateState((s) => {{
      s.stagedVersion = '0.163.0';
      s.candidateVersion = '0.163.0';
      s.status = 'ready_to_apply';
      s.budgetDate = '2026-10-13';
      s.idleCheckCount = 0;
    }});

    // Execute 12 apply attempts under active session contention on 2026-10-13
    const results = [];
    for (let i = 0; i < 12; i++) {{
      const r = await mgr.applyUpdate();
      results.push(r.reason);
    }}

    const stateAfter12 = await mgr.loadState();
    // A status transition must not grant an additional same-date budget.
    await mgr.updateState(s => {{s.status='ready_to_apply';}});
    const sameDay13 = await mgr.applyUpdate();

    // Advance injected clock to next day first slot (2026-10-14 03:05:00 UTC)
    process.env.CODEX_TEST_CLOCK = '2026-10-14T03:05:00Z';

    const fixtureRelease = {{
      tag_name: 'rust-v0.163.0',
      assets: [{{
        name: 'codex-package-x86_64-unknown-linux-musl.tar.gz',
        digest: 'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      }}]
    }};

    // checkUpdate on next day detects date change, resets idle count, and restores ready_to_apply
    const nextDayCheck = await mgr.checkUpdate('0.163.0', {{ fixtureRelease, slotKey: '2026-10-14T03:00' }});
    const stateAfterNextDay = await mgr.loadState();

    console.log(JSON.stringify({{
      last12thReason: results[11],
      sameDay13,
      stateAfter12,
      stateAfterNextDay,
      nextDayCheckBlocked: nextDayCheck.blocked || false,
      nextDayCheckPaused: nextDayCheck.paused || false
    }}));
    """
    res = run_node_eval(script, repository_root)
    assert res["last12thReason"] == "paused_busy"
    assert res["stateAfter12"]["status"] == "paused_busy"
    assert res["stateAfter12"]["idleCheckCount"] == 12
    assert res["sameDay13"]["reason"] == "paused_busy"
    assert res["sameDay13"]["state"]["idleCheckCount"] == 12
    assert "2026-10-14" in res["stateAfter12"]["nextRetryAt"]
    # On next day, budget was reset, idleCheckCount became 0, and status unpaused to ready_to_apply
    assert res["stateAfterNextDay"]["idleCheckCount"] == 0
    assert res["stateAfterNextDay"]["status"] == "ready_to_apply"
    assert res["stateAfterNextDay"]["budgetDate"] == "2026-10-14"
    assert res["nextDayCheckBlocked"] is False
    assert res["nextDayCheckPaused"] is False


def test_package_tree_containment_rejects_escaping_bin(repository_root: Path, tmp_path: Path) -> None:
    runtime_dir = tmp_path / "runtime"
    maint_dir = tmp_path / "maint"
    releases_dir = runtime_dir / "releases"
    outside_dir = tmp_path / "outside_fixture"
    outside_dir.mkdir(parents=True)
    outside_bin = outside_dir / "malicious_tool"
    outside_bin.write_text("#!/bin/sh\necho malicious", encoding="utf-8")
    outside_bin.chmod(0o755)

    candidate_dir = releases_dir / "0.163.0-x86_64-unknown-linux-musl"
    (candidate_dir / "bin").mkdir(parents=True)
    (candidate_dir / "bin/codex").symlink_to(outside_bin)
    (candidate_dir / "codex-package.json").write_text(
        json.dumps({"version": "0.163.0", "target": "x86_64-unknown-linux-musl", "entrypoint": "bin/codex"}),
        encoding="utf-8",
    )

    staged_link = runtime_dir / "staged"
    staged_link.symlink_to(candidate_dir)

    # Package with external hardlink
    hardlink_pkg = releases_dir / "0.164.0-x86_64-unknown-linux-musl"
    (hardlink_pkg / "bin").mkdir(parents=True)
    (hardlink_pkg / "codex-package.json").write_text(
        json.dumps({"version": "0.164.0", "target": "x86_64-unknown-linux-musl", "entrypoint": "bin/codex"}),
        encoding="utf-8",
    )
    os.link(outside_bin, hardlink_pkg / "bin/codex")

    # Package in updater staging extract directory
    staging_pkg = runtime_dir / "staging/.extract-valid"
    (staging_pkg / "bin").mkdir(parents=True)
    (staging_pkg / "bin/codex").write_text("#!/bin/sh\necho ok", encoding="utf-8")
    (staging_pkg / "bin/codex").chmod(0o755)
    (staging_pkg / "codex-package.json").write_text(
        json.dumps({"version": "0.165.0", "target": "x86_64-unknown-linux-musl", "entrypoint": "bin/codex"}),
        encoding="utf-8",
    )

    script = f"""
    process.env.CODEX_RUNTIME_DIR = '{runtime_dir}';
    process.env.CODEX_MAINTENANCE_DIR = '{maint_dir}';

    const check = await mgr.validateSymlinkContainment('{staged_link}');
    const treeCheck = await mgr.validateCandidatePackageTree('{candidate_dir}');
    const hardlinkCheck = await mgr.validateCandidatePackageTree('{hardlink_pkg}');
    const stagingCheck = await mgr.validateCandidatePackageTree('{staging_pkg}');
    const manifestMismatch = await mgr.validateCandidatePackageTree('{staging_pkg}', {{ expectedVersion: '9.9.9' }});
    console.log(JSON.stringify({{ check, treeCheck, hardlinkCheck, stagingCheck, manifestMismatch }}));
    """
    res = run_node_eval(script, repository_root)
    assert res["check"]["valid"] is False
    assert "escapes" in res["check"]["error"].lower() or "escaping" in res["check"]["error"].lower()
    assert res["treeCheck"]["valid"] is False
    assert "escapes" in res["treeCheck"]["error"].lower() or "escaping" in res["treeCheck"]["error"].lower()
    assert res["hardlinkCheck"]["valid"] is False
    assert "hardlink" in res["hardlinkCheck"]["error"].lower()
    assert res["stagingCheck"]["valid"] is True
    assert res["manifestMismatch"]["valid"] is False
    assert "mismatch" in res["manifestMismatch"]["error"].lower()


@pytest.mark.parametrize("in_flight", [None, 0, 1, 2])
@pytest.mark.parametrize("schema", ["full", "known_lazy", "unknown_lazy"])
def test_app_server_inspection_fails_closed_on_malformed_and_missing_gauges(
    repository_root: Path, tmp_path: Path, in_flight, schema
) -> None:
    socket_path = tmp_path / "test_app_server.sock"
    gauges = [] if in_flight is None else [
        {"name": "app.requests.in_flight", "value": in_flight},
        {"name": "app.requests.queued", "value": 0},
        {"name": "core.turns.active", "value": 0},
    ]

    if schema != "full":
        gauges = gauges[:1]

    # Start a mock Unix socket WebSocket server that returns empty diagnostics or missing gauges
    server_js = f"""
    import net from 'node:net';
    import crypto from 'node:crypto';

    let buf = Buffer.alloc(0);
    const server = net.createServer((socket) => {{
      socket.on('data', (data) => {{
        if (data.toString('utf-8').includes('Upgrade: websocket')) {{
          const text = data.toString('utf-8');
          const keyMatch = text.match(/Sec-WebSocket-Key: ([^\\r\\n]+)/);
          const key = keyMatch ? keyMatch[1].trim() : '';
          const accept = crypto.createHash('sha1')
            .update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11')
            .digest('base64');
          
          socket.write(
            'HTTP/1.1 101 Switching Protocols\\r\\n' +
            'Upgrade: websocket\\r\\n' +
            'Connection: Upgrade\\r\\n' +
            'Sec-WebSocket-Accept: ' + accept + '\\r\\n\\r\\n'
          );
          return;
        }}

        buf = Buffer.concat([buf, data]);
        while (buf.length >= 2) {{
          const b1 = buf[1];
          const isMasked = (b1 & 0x80) !== 0;
          let len = b1 & 0x7f;
          let offset = 2;
          if (len === 126) {{
            if (buf.length < 4) break;
            len = buf.readUInt16BE(2);
            offset = 4;
          }} else if (len === 127) {{
            if (buf.length < 10) break;
            len = Number(buf.readBigUInt64BE(2));
            offset = 10;
          }}
          let maskKey = null;
          if (isMasked) {{
            if (buf.length < offset + 4) break;
            maskKey = buf.slice(offset, offset + 4);
            offset += 4;
          }}
          if (buf.length < offset + len) break;
          const payload = Buffer.from(buf.slice(offset, offset + len));
          buf = buf.slice(offset + len);
          if (maskKey) {{
            for (let i = 0; i < len; i++) {{
              payload[i] ^= maskKey[i % 4];
            }}
          }}

          try {{
            const msg = JSON.parse(payload.toString('utf-8'));
            let result = {{}};
            if (msg.method === 'initialize') {{
              result = {{ serverInfo: {{ name: 'mock' }} }};
            }} else if (msg.method === 'server/diagnostics') {{
              result = {{
                process: {{ id: process.pid }},
                gauges: {json.dumps(gauges)}
              }};
            }} else if (msg.method === 'thread/loaded/list') {{
              result = {{data:[]}};
            }} else if (msg.method === 'initialized') {{
              continue;
            }}
            const respPayload = Buffer.from(JSON.stringify({{ id: msg.id, result }}));
            let header;
            if (respPayload.length < 126) {{
              header = Buffer.from([0x81, respPayload.length]);
            }} else {{
              header = Buffer.alloc(4);
              header[0] = 0x81;
              header[1] = 126;
              header.writeUInt16BE(respPayload.length, 2);
            }}
            socket.write(Buffer.concat([header, respPayload]));
          }} catch (e) {{}}
        }}
      }});
    }});

    server.listen('{socket_path}', () => {{
      console.log('READY');
    }});
    """

    srv_proc = subprocess.Popen(["node", "--input-type=module", "-e", server_js], stdout=subprocess.PIPE, text=True)
    try:
        # Wait for READY
        line = srv_proc.stdout.readline()
        assert "READY" in line

        script = f"""
        const res = await mgr.inspectAppServer('{socket_path}', {srv_proc.pid}, {json.dumps('0.162.1' if schema == 'known_lazy' else '0.163.0')});
        console.log(JSON.stringify(res));
        """
        res = run_node_eval(script, repository_root)
        assert res["busy"] is (in_flight is None or in_flight > 1)
        if res["busy"]:
            assert "gauge" in res["reason"].lower()
    finally:
        srv_proc.terminate()
        srv_proc.wait()


def test_wrapper_uses_verified_generation_resolver(repository_root: Path) -> None:
    wrapper = (repository_root / "codex_home_assistant/rootfs/usr/local/bin/codex").read_text()
    assert "ha-codex-update resolve" in wrapper
    assert 'codex_real_bin="${selected_bin}"' in wrapper
    assert "jq -n --argjson pid" in wrapper
    assert 'args:$ARGS.positional' in wrapper


def test_wrapper_argument_parsing_distinguishes_subcommands(repository_root: Path) -> None:
    wrapper_path = repository_root / "codex_home_assistant/rootfs/usr/local/bin/codex"
    wrapper_content = wrapper_path.read_text(encoding="utf-8")

    # Verify loop structure handles flag arguments
    assert "while [[ $# -gt 0 ]]; do" in wrapper_content
    assert ("-m|--model|-c|--config|-C|--cd|--profile|--color|-s|--sandbox|-p|-a|"
            "--ask-for-approval|--enable|--disable|--remote|--remote-auth-token-env|"
            "--local-provider|-i|--image|--add-dir)") in wrapper_content
    assert "shift 2" in wrapper_content
    assert "--)" in wrapper_content
    assert "update)" in wrapper_content
    assert "start_time=$(awk '{print $22}' \"/proc/$$/stat\"" in wrapper_content

    # Run bash snippet to test argument parsing behavior
    bash_test = """
    parse_args() {
      is_update_subcommand=false
      update_args=()
      while [[ $# -gt 0 ]]; do
        case "$1" in
          --) break ;;
          update)
            is_update_subcommand=true
            shift
            update_args=("$@")
            break
            ;;
          -m|--model|-c|--config|-C|--cd|--profile|--color|-s|--sandbox|-p|-a|--ask-for-approval|--enable|--disable|--remote|--remote-auth-token-env|--local-provider|-i|--image|--add-dir)
            shift 2 2>/dev/null || break
            ;;
          -m*|-c*|-C*) shift ;;
          --model=*|--config=*|--cd=*|--profile=*|--color=*|--sandbox=*) shift ;;
          -*) shift ;;
          *) break ;;
        esac
      done
      echo "subcommand=${is_update_subcommand};count=${#update_args[@]}"
    }

    echo "1:$(parse_args -m update 'hello')"
    echo "2:$(parse_args -c key=val update --status)"
    echo "3:$(parse_args --model update prompt)"
    echo "4:$(parse_args -- update)"
    echo "5:$(parse_args update status --json)"
    echo "6:$(parse_args -p home update --status)"
    echo "7:$(parse_args -a never update)"
    echo "8:$(parse_args --remote ws://host update status)"
    echo "9:$(parse_args -p prompt update my lights)"
    """
    proc = subprocess.run(["bash", "-c", bash_test], capture_output=True, text=True, check=True)
    lines = proc.stdout.strip().split("\n")
    assert lines[0] == "1:subcommand=false;count=0"
    assert lines[1] == "2:subcommand=true;count=1"
    assert lines[2] == "3:subcommand=false;count=0"
    assert lines[3] == "4:subcommand=false;count=0"
    assert lines[4] == "5:subcommand=true;count=2"
    assert lines[5] == "6:subcommand=true;count=1"
    assert lines[6] == "7:subcommand=true;count=0"
    assert lines[7] == "8:subcommand=true;count=1"
    assert lines[8] == "9:subcommand=true;count=2"


def test_codex_updater_s6_service_contract(rootfs: Path) -> None:
    s6_dir = rootfs / "etc/s6-overlay/s6-rc.d/codex-updater"
    assert (s6_dir / "type").read_text().strip() == "longrun"
    assert (s6_dir / "dependencies.d/codex-ha-init").is_file()
    assert (rootfs / "etc/s6-overlay/s6-rc.d/user/contents.d/codex-updater").is_file()

    run_script = (s6_dir / "run").read_text(encoding="utf-8")
    assert run_script.startswith("#!/command/with-contenv bashio\n")
    assert "unset SUPERVISOR_TOKEN" in run_script
    assert "exec node /usr/local/share/codex-ha/codex-updater-daemon.mjs" in run_script


def test_server_graceful_restart_transaction_with_fixture_process(
    repository_root: Path, tmp_path: Path
) -> None:
    runtime_dir = tmp_path / "runtime"
    maint_dir = tmp_path / "maint"
    socket_path = tmp_path / "mock_app_server.sock"
    signal_file = tmp_path / "signal_received.txt"
    runtime_dir.mkdir(parents=True)
    maint_dir.mkdir(parents=True)

    # Server script that responds as idle and records SIGHUP
    server_js = f"""
    import net from 'node:net';
    import crypto from 'node:crypto';
    import fs from 'node:fs';

    let sigtermReceived = false;
    process.on('SIGHUP', () => {{
      sigtermReceived = true;
      fs.writeFileSync('{signal_file}', 'SIGHUP');
      process.exit(0);
    }});

    let buf = Buffer.alloc(0);
    const server = net.createServer((socket) => {{
      socket.on('data', (data) => {{
        const text = data.toString('utf-8');
        if (text.includes('Upgrade: websocket')) {{
          const keyMatch = text.match(/Sec-WebSocket-Key: ([^\\r\\n]+)/);
          const key = keyMatch ? keyMatch[1].trim() : '';
          const accept = crypto.createHash('sha1')
            .update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11')
            .digest('base64');
          
          socket.write(
            'HTTP/1.1 101 Switching Protocols\\r\\n' +
            'Upgrade: websocket\\r\\n' +
            'Connection: Upgrade\\r\\n' +
            'Sec-WebSocket-Accept: ' + accept + '\\r\\n\\r\\n'
          );
          return;
        }}

        buf = Buffer.concat([buf, data]);
        while (buf.length >= 2) {{
          const b1 = buf[1];
          const isMasked = (b1 & 0x80) !== 0;
          let len = b1 & 0x7f;
          let offset = 2;
          if (len === 126) {{
            if (buf.length < 4) break;
            len = buf.readUInt16BE(2);
            offset = 4;
          }} else if (len === 127) {{
            if (buf.length < 10) break;
            len = Number(buf.readBigUInt64BE(2));
            offset = 10;
          }}
          let maskKey = null;
          if (isMasked) {{
            if (buf.length < offset + 4) break;
            maskKey = buf.slice(offset, offset + 4);
            offset += 4;
          }}
          if (buf.length < offset + len) break;
          const payload = Buffer.from(buf.slice(offset, offset + len));
          buf = buf.slice(offset + len);
          if (maskKey) {{
            for (let i = 0; i < len; i++) {{
              payload[i] ^= maskKey[i % 4];
            }}
          }}

          try {{
            const msg = JSON.parse(payload.toString('utf-8'));
            let result = {{}};
            if (msg.method === 'initialize') {{
              result = {{ serverInfo: {{ name: 'mock' }} }};
            }} else if (msg.method === 'server/diagnostics') {{
              result = {{
                process: {{ id: process.pid }},
                gauges: [
                  {{ name: 'app.requests.in_flight', value: 0 }},
                  {{ name: 'app.requests.queued', value: 0 }},
                  {{ name: 'core.turns.active', value: 0 }}
                ]
              }};
            }} else if (msg.method === 'thread/loaded/list') {{
              result = {{ data: [] }};
            }} else if (msg.method === 'initialized') {{
              continue;
            }}
            const respPayload = Buffer.from(JSON.stringify({{ id: msg.id, result }}));
            let header;
            if (respPayload.length < 126) {{
              header = Buffer.from([0x81, respPayload.length]);
            }} else {{
              header = Buffer.alloc(4);
              header[0] = 0x81;
              header[1] = 126;
              header.writeUInt16BE(respPayload.length, 2);
            }}
            socket.write(Buffer.concat([header, respPayload]));
          }} catch (e) {{}}
        }}
      }});
    }});

    server.listen('{socket_path}', () => {{
      console.log('READY');
    }});
    """

    server_launcher = tmp_path / "baseline" / "bin" / "codex"
    server_launcher.parent.mkdir(parents=True, exist_ok=True)
    server_file = tmp_path / "server.mjs"
    server_file.write_text(server_js, encoding="utf-8")
    server_launcher.write_text('#!/usr/bin/env node\nif (process.argv.includes("--version")) { console.log("codex-cli 0.162.1"); process.exit(0); }\n' + server_js, encoding="utf-8")
    (tmp_path / "baseline/codex-package.json").write_text(json.dumps({"version": "0.162.1", "target": "x86_64-unknown-linux-musl", "entrypoint": "bin/codex"}))
    server_launcher.chmod(0o755)

    srv_proc = subprocess.Popen(
        [str(server_launcher), "app-server", "--listen", f"unix://{socket_path}"],
        stdout=subprocess.PIPE,
        text=True,
    )
    try:
        line = srv_proc.stdout.readline()
        assert "READY" in line

        # Register managed launch record for srv_proc
        srv_stat = Path(f"/proc/{srv_proc.pid}/stat").read_text().rsplit(")", 1)[1].split()
        srv_start = srv_stat[19]
        sessions_dir = maint_dir / "sessions"
        sessions_dir.mkdir(parents=True, exist_ok=True)
        session_record = {
            "pid": srv_proc.pid,
            "start": srv_start,
            "type": "app-server",
            "managed": True,
            "socketPath": str(socket_path),
            "exe": str(server_launcher),
            "version": "0.162.1",
            "cwd": str(tmp_path),
            "args": ["app-server", "--listen", f"unix://{socket_path}"],
        }
        (sessions_dir / str(srv_proc.pid)).write_text(json.dumps(session_record))

        # Node replacement script for candidate bin/codex
        new_codex_js = f"""#!/usr/bin/env node
import fs from 'node:fs';
import net from 'node:net';
import crypto from 'node:crypto';

if (process.argv.includes('--version')) {{
  console.log('codex-cli 0.163.0');
  process.exit(0);
}}
if (process.argv.includes('--help')) {{
  console.log('help');
  process.exit(0);
}}

const sockArgIdx = process.argv.indexOf('--listen');
let sockPath = '{socket_path}';
if (sockArgIdx !== -1 && process.argv[sockArgIdx + 1]) {{
  sockPath = process.argv[sockArgIdx + 1].replace('unix://', '');
}}

try {{ fs.unlinkSync(sockPath); }} catch {{}}
let buf = Buffer.alloc(0);
const server = net.createServer((socket) => {{
  socket.on('data', (data) => {{
    const text = data.toString('utf-8');
    if (text.includes('Upgrade: websocket')) {{
      const keyMatch = text.match(/Sec-WebSocket-Key: ([^\\r\\n]+)/);
      const key = keyMatch ? keyMatch[1].trim() : '';
      const accept = crypto.createHash('sha1')
        .update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11')
        .digest('base64');
      socket.write(
        'HTTP/1.1 101 Switching Protocols\\r\\n' +
        'Upgrade: websocket\\r\\n' +
        'Connection: Upgrade\\r\\n' +
        'Sec-WebSocket-Accept: ' + accept + '\\r\\n\\r\\n'
      );
      return;
    }}
    buf = Buffer.concat([buf, data]);
    while (buf.length >= 2) {{
      const b1 = buf[1];
      const isMasked = (b1 & 0x80) !== 0;
      let len = b1 & 0x7f;
      let offset = 2;
      if (len === 126) {{
        if (buf.length < 4) break;
        len = buf.readUInt16BE(2);
        offset = 4;
      }} else if (len === 127) {{
        if (buf.length < 10) break;
        len = Number(buf.readBigUInt64BE(2));
        offset = 10;
      }}
      let maskKey = null;
      if (isMasked) {{
        if (buf.length < offset + 4) break;
        maskKey = buf.slice(offset, offset + 4);
        offset += 4;
      }}
      if (buf.length < offset + len) break;
      const payload = Buffer.from(buf.slice(offset, offset + len));
      buf = buf.slice(offset + len);
      if (maskKey) {{
        for (let i = 0; i < len; i++) payload[i] ^= maskKey[i % 4];
      }}
      try {{
        const msg = JSON.parse(payload.toString('utf-8'));
        let result = {{}};
        if (msg.method === 'initialize') {{
          result = {{ serverInfo: {{ name: 'mock-new' }} }};
        }} else if (msg.method === 'server/diagnostics') {{
          result = {{
            process: {{ id: process.pid }},
            gauges: [
              {{ name: 'app.requests.in_flight', value: 0 }},
              {{ name: 'app.requests.queued', value: 0 }},
              {{ name: 'core.turns.active', value: 0 }}
            ]
          }};
        }} else if (msg.method === 'thread/loaded/list') {{
          result = {{ data: [] }};
        }}
        const respPayload = Buffer.from(JSON.stringify({{ id: msg.id, result }}));
        let header;
        if (respPayload.length < 126) {{
          header = Buffer.from([0x81, respPayload.length]);
        }} else {{
          header = Buffer.alloc(4);
          header[0] = 0x81;
          header[1] = 126;
          header.writeUInt16BE(respPayload.length, 2);
        }}
        socket.write(Buffer.concat([header, respPayload]));
      }} catch (e) {{}}
    }}
  }});
}});
server.listen(sockPath);
"""

        script = f"""
        process.env.CODEX_RUNTIME_DIR = '{runtime_dir}';
        process.env.CODEX_MAINTENANCE_DIR = '{maint_dir}';
        process.env.CODEX_BASELINE_DIR = '{tmp_path}/baseline';

        await mgr.initRuntime();

        // Create staged candidate package
        const candidateDir = mgr.getReleasesDir() + '/0.163.0-x86_64-unknown-linux-musl';
        await (await import('node:fs/promises')).mkdir(candidateDir + '/bin', {{ recursive: true }});
        await (await import('node:fs/promises')).writeFile(candidateDir + '/bin/codex', {json.dumps(new_codex_js)});
        await (await import('node:fs/promises')).chmod(candidateDir + '/bin/codex', 0o755);
        await (await import('node:fs/promises')).writeFile(
          candidateDir + '/codex-package.json',
          JSON.stringify({{ version: '0.163.0', target: 'x86_64-unknown-linux-musl', entrypoint: 'bin/codex' }})
        );
        await sealFixture(candidateDir);
    await (await import('node:fs/promises')).symlink(candidateDir, mgr.getStagedLink());

        await mgr.updateState((s) => {{
          s.stagedVersion = '0.163.0';
          s.status = 'ready_to_apply';
        }});

        // Inspect sessions: verify managed app-server is recognized as restartable
        const inspect1 = await mgr.inspectAllSessions();

        // Apply update with restartable app-server
        const apply1 = await mgr.applyUpdate({{ policyProbe: async () => ({{ valid: true }}) }});
        const state1 = await mgr.loadState();

        // Test cooldown behavior: probe must be skipped, budget must be tracked up to 12 checks
        let probeCount = 0;
        const probeFn = async () => {{ probeCount++; return {{ valid: true }}; }};

        await sealFixture(candidateDir);
        try {{ await (await import('node:fs/promises')).rm(mgr.getStagedLink(), {{ force: true }}); }} catch {{}}
        await (await import('node:fs/promises')).symlink(candidateDir, mgr.getStagedLink());
        await mgr.updateState((s) => {{
          s.stagedVersion = '0.163.0';
          s.status = 'ready_to_apply';
        }});

        const cooldownChecks = [];
        for (let i = 1; i <= 13; i++) {{
          const res = await mgr.applyUpdate({{ policyProbe: probeFn }});
          const st = await mgr.loadState();
          cooldownChecks.push({{
            iteration: i,
            applied: res.applied,
            reason: res.reason,
            status: st.status,
            idleCheckCount: st.idleCheckCount,
            probeCount
          }});
        }}

        // Advance test clock past 24h
        process.env.CODEX_TEST_CLOCK = new Date(Date.now() + 25 * 3600 * 1000).toISOString();
        const now25h = mgr.getNow().getTime();
        const cooldownExpired = state1.nextRestartAllowedAt && new Date(state1.nextRestartAllowedAt).getTime() <= now25h;

        console.log(JSON.stringify({{ inspect1, apply1, state1, cooldownChecks, cooldownExpired }}));
        """
        res = run_node_eval(script, repository_root)

        # Verification of actual restart execution
        assert len(res["inspect1"]["restartableServers"]) == 1
        assert res["inspect1"]["restartableServers"][0]["pid"] == srv_proc.pid
        assert res["apply1"]["applied"] is True
        assert res["apply1"]["version"] == "0.163.0"
        assert res["state1"]["restartAttemptCount"] == 1
        assert res["state1"]["status"] == "applied"

        # Verification that policy probe was NEVER called during cooldown across all 13 checks
        checks = res["cooldownChecks"]
        assert all(c["probeCount"] == 0 for c in checks)

        # Checks 1 to 11 return restart_cooldown with incrementing idleCheckCount
        for i in range(11):
            assert checks[i]["applied"] is False
            assert checks[i]["reason"] == "restart_cooldown"
            assert checks[i]["idleCheckCount"] == i + 1

        # Check 12 hits MAX_IDLE_CHECKS = 12 and transitions to paused_busy
        assert checks[11]["applied"] is False
        assert checks[11]["reason"] == "paused_busy"
        assert checks[11]["status"] == "paused_busy"
        assert checks[11]["idleCheckCount"] == 12

        # Check 13 remains paused_busy with idleCheckCount = 12
        assert checks[12]["applied"] is False
        assert checks[12]["reason"] == "paused_busy"
        assert checks[12]["status"] == "paused_busy"
        assert checks[12]["idleCheckCount"] == 12

        assert res["cooldownExpired"] is True

        # Assert old server actually received the graceful-only SIGHUP from updater!
        assert signal_file.exists()
        assert signal_file.read_text().strip() == "SIGHUP"
    finally:
        srv_proc.terminate()
        srv_proc.wait()
        for record_file in (maint_dir / "sessions").glob("*"):
            try:
                os.kill(json.loads(record_file.read_text())["pid"], 15)
            except (ProcessLookupError, ValueError, KeyError):
                pass


def test_download_and_stage_package_positive_and_immutable_release(
    repository_root: Path, tmp_path: Path
) -> None:
    runtime_dir = tmp_path / "runtime"
    maint_dir = tmp_path / "maint"
    web_dir = tmp_path / "web"
    runtime_dir.mkdir(parents=True)
    maint_dir.mkdir(parents=True)
    web_dir.mkdir(parents=True)

    # Build a valid candidate package tar.gz
    pkg_dir = tmp_path / "pkg_src"
    (pkg_dir / "bin").mkdir(parents=True)
    bin_content = "#!/bin/sh\nif [ \"$1\" = \"--version\" ]; then echo \"codex-cli 0.163.0\"; exit 0; fi\nexit 0\n"
    (pkg_dir / "bin/codex").write_text(bin_content, encoding="utf-8")
    (pkg_dir / "bin/codex").chmod(0o755)
    (pkg_dir / "codex-package.json").write_text(
        json.dumps({"version": "0.163.0", "target": "x86_64-unknown-linux-musl", "entrypoint": "bin/codex"}),
        encoding="utf-8",
    )

    archive_path = web_dir / "codex-package-x86_64-unknown-linux-musl.tar.gz"
    with tarfile.open(archive_path, "w:gz") as tar:
        tar.add(pkg_dir / "bin/codex", arcname="bin/codex")
        tar.add(pkg_dir / "codex-package.json", arcname="codex-package.json")

    digest = hashlib.sha256(archive_path.read_bytes()).hexdigest()

    class Handler(http.server.SimpleHTTPRequestHandler):
        def __init__(self, *args, **kwargs):
            super().__init__(*args, directory=str(web_dir), **kwargs)

        def log_message(self, format, *args):
            pass

    server = http.server.HTTPServer(("127.0.0.1", 0), Handler)
    port = server.server_port
    server_thread = threading.Thread(target=server.serve_forever, daemon=True)
    server_thread.start()

    download_url = f"http://127.0.0.1:{port}/codex-package-x86_64-unknown-linux-musl.tar.gz"

    try:
        script = f"""
        process.env.CODEX_RUNTIME_DIR = '{runtime_dir}';
        process.env.CODEX_MAINTENANCE_DIR = '{maint_dir}';

        await mgr.initRuntime();

        const releaseInfo = {{
          version: '0.163.0',
          assets: [{{
            name: 'codex-package-x86_64-unknown-linux-musl.tar.gz',
            digest: 'sha256:{digest}',
            browser_download_url: '{download_url}'
          }}]
        }};

        // 1. First download and stage -> positive path
        const res1 = await mgr.downloadAndStagePackage(releaseInfo);

        // Record inode of destDir/bin/codex
        const fs = await import('node:fs/promises');
        const stat1 = await fs.stat(res1.path + '/bin/codex');

        // 2. Second download and stage with same version -> immutable destination reuse
        const res2 = await mgr.downloadAndStagePackage(releaseInfo);
        const stat2 = await fs.stat(res2.path + '/bin/codex');

        // 3. Download with SHA-256 mismatch -> must fail closed
        let mismatchFailed = false;
        let mismatchError = '';
        try {{
          await mgr.downloadAndStagePackage({{
            version: '0.163.0',
            assets: [{{
              name: 'codex-package-x86_64-unknown-linux-musl.tar.gz',
              digest: 'sha256:0000000000000000000000000000000000000000000000000000000000000000',
              browser_download_url: '{download_url}'
            }}]
          }});
        }} catch (err) {{
          mismatchFailed = true;
          mismatchError = err.message;
        }}

        // Check that temp download/extract files were cleaned up
        const stagingEntries = await fs.readdir(mgr.getStagingDir());
        const tempRemnants = stagingEntries.filter(e => e.startsWith('.download-') || e.startsWith('.extract-'));

        console.log(JSON.stringify({{
          res1,
          res2,
          sameInode: stat1.ino === stat2.ino,
          mismatchFailed,
          mismatchError,
          tempRemnants
        }}));
        """
        res = run_node_eval(script, repository_root)
        assert res["res1"]["version"] == "0.163.0"
        assert res["sameInode"] is True  # Proves destDir was immutably reused without deleting running bytes!
        assert res["mismatchFailed"] is True
        assert "mismatch" in res["mismatchError"].lower()
        assert len(res["tempRemnants"]) == 0
    finally:
        server.shutdown()
        server.server_close()




@pytest.mark.parametrize('mutation', ['bin', 'resource', 'extra', 'missing', 'manifest', 'hardlink'])
@pytest.mark.parametrize('reference', ['relative_current', 'absolute_current', 'previous_only', 'staged_only', 'executable_only', 'resource_only'])
def test_verified_bytes_and_active_generation_are_preserved(repository_root: Path, tmp_path: Path, mutation: str, reference: str) -> None:
    source = tmp_path / 'source'
    (source / 'bin').mkdir(parents=True)
    (source / 'bin/codex').write_text('#!/usr/bin/env node\nif(process.argv.includes("--version")){console.log("codex-cli 0.163.0");process.exit(0);} if(process.argv.length>2)process.exit(0); setInterval(()=>{},1000);\n')
    (source / 'bin/codex').chmod(0o755)
    (source / 'resource').write_text('verified resource')
    (source / 'codex-package.json').write_text(json.dumps({'version': '0.163.0', 'target': 'x86_64-unknown-linux-musl', 'entrypoint': 'bin/codex'}))
    archive = tmp_path / 'package.tar.gz'
    with tarfile.open(archive, 'w:gz') as tar:
        for child in source.iterdir():
            tar.add(child, arcname=child.name)
    digest = hashlib.sha256(archive.read_bytes()).hexdigest()
    script = f"""
    const fs = await import('node:fs/promises');
    process.env.CODEX_RUNTIME_DIR = '{tmp_path}/runtime';
    process.env.CODEX_MAINTENANCE_DIR = '{tmp_path}/maintenance';
    process.env.CODEX_BASELINE_DIR = '{tmp_path}/baseline';
    await fs.mkdir(process.env.CODEX_BASELINE_DIR, {{recursive:true}});
    await fs.cp('{source}', process.env.CODEX_BASELINE_DIR, {{recursive:true}});
    await mgr.initRuntime();
    const info = {{version:'0.163.0', expectedSha256:'{digest}'}};
    const staged = await mgr.downloadAndStagePackage(info, '{archive.as_uri()}');
    const binary = staged.path + '/bin/codex';
    const inode = (await fs.stat(binary)).ino;
    await mgr.updateState(s => {{s.stagedVersion='0.163.0';s.candidateVersion='0.163.0';s.candidateDigest='{digest}';}});
    const relative = 'releases/' + (await import('node:path')).basename(staged.path);
    if ('{reference}' === 'relative_current' || '{reference}' === 'absolute_current') {{
      await fs.unlink(mgr.getCurrentLink());
      await fs.symlink('{reference}' === 'relative_current' ? relative : staged.path, mgr.getCurrentLink());
    }}
    if ('{reference}' === 'previous_only') {{
      await fs.unlink(mgr.getStagedLink());
      await fs.symlink(relative, mgr.getPreviousLink());
    }}
    let live;
    if ('{reference}' === 'executable_only' || '{reference}' === 'resource_only') {{
      await fs.unlink(mgr.getStagedLink());
      const {{spawn}} = await import('node:child_process');
      live = '{reference}' === 'executable_only'
        ? spawn(binary, [], {{stdio:'ignore'}})
        : spawn('node', ['-e', 'require("fs").openSync(process.argv[1],"r");setInterval(()=>{{}},1000)', staged.path+'/resource'], {{stdio:'ignore'}});
      live.unref();
      await new Promise(r=>setTimeout(r,100));
      if (!await mgr.inspectProcess(live.pid)) throw new Error('reference fixture did not start');
    }}
    const mutation = '{mutation}';
    if (mutation === 'bin') await fs.appendFile(binary, '# modified bytes\\n');
    if (mutation === 'resource') await fs.writeFile(staged.path + '/resource', 'changed');
    if (mutation === 'extra') await fs.writeFile(staged.path + '/extra', 'unverified');
    if (mutation === 'missing') await fs.unlink(staged.path + '/resource');
    if (mutation === 'manifest') await fs.writeFile(staged.path + '/codex-package.json', '{{"version":"9.9.9","target":"wrong","entrypoint":"bin/codex"}}');
    if (mutation === 'hardlink') await fs.link(binary, '{tmp_path}/hardlink');
    const before = await fs.readlink(mgr.getCurrentLink());
    let reuseRejected = false;
    try {{ await mgr.downloadAndStagePackage(info, '{archive.as_uri()}'); }} catch {{ reuseRejected = true; }}
    const applied = await mgr.applyUpdate({{policyProbe:async()=>({{valid:true}})}});
    const after = await fs.readlink(mgr.getCurrentLink());
    const preserved = inode === (await fs.stat(binary)).ino;
    // Restart recovery must not retain the changed selected override.
    await mgr.initRuntime();
    const recovered = await fs.readlink(mgr.getCurrentLink());
    const livePreserved = !live || Boolean(await mgr.inspectProcess(live.pid));
    if(live) live.kill('SIGTERM');
    console.log(JSON.stringify({{reuseRejected, applied:applied.applied, reason:applied.reason, preserved, livePreserved, sameCurrent:before===after, recovered}}));
    """
    result = run_node_eval(script, repository_root)
    assert result['reuseRejected'] is True
    assert result['applied'] is False
    assert result['reason'] == 'blocked_integrity'
    assert result['preserved'] is True
    assert result['livePreserved'] is True
    assert result['sameCurrent'] is True
    assert result['recovered'] == str(tmp_path / 'baseline')


def test_help_success_does_not_authorize_managed_policy(repository_root: Path, tmp_path: Path) -> None:
    package = tmp_path / 'package'
    (package / 'bin').mkdir(parents=True)
    binary = package / 'bin/codex'
    binary.write_text('#!/bin/sh\necho help\nexit 0\n')
    binary.chmod(0o755)
    (package / 'codex-package.json').write_text(json.dumps({'version':'0.163.0','target':'x86_64-unknown-linux-musl'}))
    for relative in ['bin/codex-code-mode-host', 'codex-resources/bwrap', 'codex-path/rg']:
        path = package / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text('#!/bin/sh\nexit 0\n')
        path.chmod(0o755)
    profile = tmp_path / 'profile'
    profile.write_text('codex-fixture (enforce)')
    script = f"""
    const {{verifyManagedPolicy}} = await import('./codex_home_assistant/rootfs/usr/local/share/codex-ha/codex-policy-probe.mjs');
    const result = await verifyManagedPolicy('{package}', {{profile:'{profile}', requirements:'{repository_root}/codex_home_assistant/rootfs/etc/codex/requirements.toml', workspacePrefix:'{tmp_path}/workspace-'}});
    console.log(JSON.stringify(result));
    """
    result = run_node_eval(script, repository_root)
    assert result['valid'] is False
    assert result['reason'] == 'managed_policy_probe_failed'


@pytest.mark.parametrize("failure", ["launch", "readiness", "restore", "second_server", "drain", "second_drain"])
def test_restart_failure_restores_actual_servers_or_reports_incomplete(
    repository_root: Path, tmp_path: Path, failure: str
) -> None:
    # Real processes and Unix sockets; only the RPC idle adapter is injected.
    old = tmp_path / "old.mjs"
    new = tmp_path / "new.mjs"
    launches = tmp_path / "launches.jsonl"
    signals = tmp_path / "signals.jsonl"
    template = """#!/usr/bin/env node
import fs from 'node:fs';
import net from 'node:net';
const version = VERSION;
if (process.argv.includes('--version')) { console.log('codex-cli ' + version); process.exit(0); }
const id = process.argv[2], socket = process.argv[3];
fs.appendFileSync(LAUNCHES, JSON.stringify({pid:process.pid,version,id})+'\\n');
process.on('SIGHUP',()=>{
  fs.appendFileSync(SIGNALS,JSON.stringify({pid:process.pid,version,id})+'\\n');
  if (!IGNORE_SIGHUP) process.exit(0);
});
if (FAIL_LAUNCH) process.exit(7);
try { fs.unlinkSync(socket); } catch {}
if (!FAIL_READY) net.createServer().listen(socket);
else setInterval(()=>{},1000);
"""
    for path, version in [(old, "0.162.1"), (new, "0.163.0")]:
        is_new = path == new
        path.write_text(template.replace("VERSION", json.dumps(version))
                        .replace("LAUNCHES", json.dumps(str(launches)))
                        .replace("SIGNALS", json.dumps(str(signals)))
                        .replace("FAIL_LAUNCH", "true" if is_new and failure in ["launch", "restore"] else
                                 "id === '2'" if is_new and failure == "second_server" else "false")
                        .replace("FAIL_READY", "true" if is_new and failure == "readiness" else "false")
                        .replace("IGNORE_SIGHUP", "true" if (not is_new and failure == "drain") else
                                 "id === '2'" if (not is_new and failure == "second_drain") else "false"))
        path.chmod(0o755)
    script = f"""
      const fs = await import('node:fs/promises');
      const {{spawn}} = await import('node:child_process');
      const {{restartServers}} = await import('./codex_home_assistant/rootfs/usr/local/share/codex-ha/codex-server-transaction.mjs');
      const wait = ms => new Promise(r=>setTimeout(r,ms));
      const servers = [], records = new Map();
      let attempt = 0, selected = 'old';
      const count = {2 if failure in ['second_server', 'second_drain'] else 1};
      for (let id=1; id<=count; id++) {{
        const socketPath = {json.dumps(str(tmp_path))} + '/server-' + id + '.sock';
        const args = [String(id), socketPath];
        const child = spawn({json.dumps(str(old))}, args, {{stdio:'ignore'}}); child.unref();
        for (let n=0;n<50;n++) {{ try {{if ((await fs.stat(socketPath)).isSocket()) break;}} catch {{}} await wait(20); }}
        const proc = await mgr.inspectProcess(child.pid);
        const record = {{pid:child.pid,start:proc.startTime,exe:{json.dumps(str(old))},version:'0.162.1',args,cwd:{json.dumps(str(tmp_path))}}};
        records.set(child.pid, record);
        servers.push({{pid:child.pid,start:proc.startTime,socketPath,managedRecord:record}});
      }}
      const result = await restartServers({{
        servers,binary:{json.dumps(str(new))},version:'0.163.0', inspectProcess:mgr.inspectProcess,
        inspectServer:async socket=>{{try {{return {{busy:!(await fs.stat(socket)).isSocket()}};}}catch{{return {{busy:true}};}}}},
        switchToNew:async()=>{{selected='new'; {'await fs.unlink(' + json.dumps(str(old)) + ');' if failure == 'restore' else ''} }},
        switchToOld:async()=>{{selected='old';}},
        writeRecord:async(pid, record)=>records.set(pid, record), removeRecord:async pid=>records.delete(pid),
        commitAttempt:async()=>{{attempt++;}}
      }});
      const live=[];
      for(const record of records.values()) {{const proc=await mgr.inspectProcess(record.pid);if(proc)live.push({{...record,startMatches:proc.startTime===record.start}});}}
      const all=(await fs.readFile({json.dumps(str(launches))},'utf8')).trim().split('\\n').map(JSON.parse);
      const newLive=[];
      for(const item of all) {{if(item.version==='0.163.0' && await mgr.inspectProcess(item.pid))newLive.push(item.pid);}}
      for(const item of all) {{try{{process.kill(item.pid,'SIGTERM');}}catch{{}}}}
      console.log(JSON.stringify({{result,attempt,selected,live,newLive}}));
    """
    try:
        result = run_node_eval(script, repository_root)
        assert result["result"]["applied"] is False
        assert result["attempt"] == 1
        assert result["selected"] == "old"
        assert result["newLive"] == []
        from collections import Counter
        received = Counter(json.loads(line)["pid"] for line in signals.read_text().splitlines())
        assert received and all(count == 1 for count in received.values())
        if failure in ["restore", "drain"]:
            assert result["result"]["recovery"] == "rollback_incomplete"
            assert len(result["live"]) == (1 if failure == "drain" else 0)
        elif failure == "second_drain":
            assert result["result"]["recovery"] == "rollback_incomplete"
            assert result["result"]["reason"] == "drain_timeout"
            assert len(result["live"]) == 2
            assert all(r["version"] == "0.162.1" and r["startMatches"] for r in result["live"])
        else:
            assert result["result"]["recovery"] == "restored"
            assert len(result["live"]) == (2 if failure == "second_server" else 1)
            assert all(r["version"] == "0.162.1" and r["startMatches"] for r in result["live"])
    finally:
        if launches.exists():
            for line in launches.read_text().splitlines():
                try:
                    os.kill(json.loads(line)["pid"], 15)
                except ProcessLookupError:
                    pass

@pytest.mark.parametrize('entries', [5000, 5001])
def test_archive_entry_limit_boundary(repository_root: Path, tmp_path: Path, entries: int) -> None:
    archive = tmp_path / 'entries.tar.gz'
    binary = b'#!/bin/sh\necho codex-cli 0.163.0\n'
    manifest = json.dumps({'version':'0.163.0','target':'x86_64-unknown-linux-musl','entrypoint':'bin/codex'}).encode()
    with tarfile.open(archive, 'w:gz') as tar:
        directory = tarfile.TarInfo('bin')
        directory.type = tarfile.DIRTYPE
        directory.mode = 0o755
        tar.addfile(directory)
        for name, data, mode in [('bin/codex', binary, 0o755), ('codex-package.json', manifest, 0o644)]:
            info = tarfile.TarInfo(name)
            info.size = len(data)
            info.mode = mode
            tar.addfile(info, io.BytesIO(data))
        for index in range(entries - 3):
            info = tarfile.TarInfo(f'extra-{index}')
            info.mode = 0o644
            tar.addfile(info)
    digest = hashlib.sha256(archive.read_bytes()).hexdigest()
    result = run_node_eval(f"""
      process.env.CODEX_RUNTIME_DIR={json.dumps(str(tmp_path / 'runtime'))};
      process.env.CODEX_MAINTENANCE_DIR={json.dumps(str(tmp_path / 'maintenance'))};
      await mgr.initRuntime();
      try {{
        await mgr.downloadAndStagePackage({{version:'0.163.0',expectedSha256:'{digest}'}},'{archive.as_uri()}');
        console.log(JSON.stringify({{accepted:true}}));
      }} catch(error) {{ console.log(JSON.stringify({{accepted:false,reason:error.message}})); }}
    """, repository_root)
    assert result['accepted'] is (entries == 5000)
    if entries > 5000:
        assert 'entry count' in result['reason']


def test_cleanup_old_releases_preserves_live_fd_and_resource_references(
    repository_root: Path, tmp_path: Path
) -> None:
    runtime_dir = tmp_path / "runtime"
    maint_dir = tmp_path / "maintenance"
    releases_dir = runtime_dir / "releases"
    releases_dir.mkdir(parents=True)
    maint_dir.mkdir(parents=True)

    rel_160 = releases_dir / "0.160.0-x86_64-unknown-linux-musl"
    (rel_160 / "bin").mkdir(parents=True)
    (rel_160 / "resources").mkdir(parents=True)
    (rel_160 / "bin" / "codex").write_text("#!/bin/sh\necho codex-cli 0.160.0\n")
    (rel_160 / "bin" / "codex").chmod(0o755)
    (rel_160 / "codex-package.json").write_text(json.dumps({
        "version": "0.160.0", "target": "x86_64-unknown-linux-musl", "entrypoint": "bin/codex"
    }))
    resource_file = rel_160 / "resources" / "data.txt"
    resource_file.write_text("companion resource data\n")

    rel_162 = releases_dir / "0.162.1-x86_64-unknown-linux-musl"
    (rel_162 / "bin").mkdir(parents=True)
    (rel_162 / "bin" / "codex").write_text("#!/bin/sh\necho codex-cli 0.162.1\n")
    (rel_162 / "bin" / "codex").chmod(0o755)
    (rel_162 / "codex-package.json").write_text(json.dumps({
        "version": "0.162.1", "target": "x86_64-unknown-linux-musl", "entrypoint": "bin/codex"
    }))

    rel_163 = releases_dir / "0.163.0-x86_64-unknown-linux-musl"
    (rel_163 / "bin").mkdir(parents=True)
    (rel_163 / "bin" / "codex").write_text("#!/bin/sh\necho codex-cli 0.163.0\n")
    (rel_163 / "bin" / "codex").chmod(0o755)
    (rel_163 / "codex-package.json").write_text(json.dumps({
        "version": "0.163.0", "target": "x86_64-unknown-linux-musl", "entrypoint": "bin/codex"
    }))

    (runtime_dir / "current").symlink_to(rel_162)

    reader_script = """
    import fs from 'node:fs';
    import readline from 'node:readline';
    const rl = readline.createInterface({ input: process.stdin });
    rl.on('line', (line) => {
      const fd = fs.openSync(line.trim(), 'r');
      console.log('OPENED');
      setInterval(() => {}, 1000);
    });
    """
    reader = subprocess.Popen(
        ["node", "--input-type=module", "-e", reader_script],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        text=True,
    )
    proc_dir = tmp_path / "proc"
    proc_dir.mkdir(parents=True)
    reader_proc = proc_dir / str(reader.pid)
    reader_proc.symlink_to(f"/proc/{reader.pid}")

    try:
        reader.stdin.write(f"{resource_file}\n")
        reader.stdin.flush()
        line = reader.stdout.readline()
        assert "OPENED" in line

        script = f"""
        process.env.CODEX_RUNTIME_DIR = {json.dumps(str(runtime_dir))};
        process.env.CODEX_MAINTENANCE_DIR = {json.dumps(str(maint_dir))};
        process.env.CODEX_PROC_DIR = {json.dumps(str(proc_dir))};
        await mgr.initRuntime();
        await sealFixture({json.dumps(str(rel_163))});
        await (await import('node:fs/promises')).symlink({json.dumps(str(rel_163))}, mgr.getStagedLink());
        await mgr.updateState(s => {{
          s.stagedVersion = '0.163.0';
          s.status = 'ready_to_apply';
        }});
        const applyRes = await mgr.applyUpdate({{ policyProbe: async () => ({{ valid: true }}) }});
        const existsWhileOpen = (await import('node:fs')).existsSync({json.dumps(str(rel_160))});
        console.log(JSON.stringify({{ applyRes, existsWhileOpen }}));
        """
        res = run_node_eval(script, repository_root)
        assert res["applyRes"]["applied"] is True
        assert res["existsWhileOpen"] is True
        assert resource_file.exists()
    finally:
        reader.terminate()
        reader.wait()

    script2 = f"""
    process.env.CODEX_RUNTIME_DIR = {json.dumps(str(runtime_dir))};
    process.env.CODEX_MAINTENANCE_DIR = {json.dumps(str(maint_dir))};
    process.env.CODEX_PROC_DIR = {json.dumps(str(proc_dir))};
    const gcRes = await mgr.cleanupOldReleases('0.163.0', {json.dumps(str(rel_162))});
    const existsAfterClose = (await import('node:fs')).existsSync({json.dumps(str(rel_160))});
    console.log(JSON.stringify({{ gcRes, existsAfterClose }}));
    """
    res2 = run_node_eval(script2, repository_root)
    assert res2["gcRes"]["deferred"] is not True
    assert res2["existsAfterClose"] is False
    assert not rel_160.exists()


def test_cleanup_old_releases_aborts_on_eacces_inspection_error(
    repository_root: Path, tmp_path: Path
) -> None:
    runtime = tmp_path / "runtime"
    old = runtime / "releases" / "0.160.0-x86_64-unknown-linux-musl"
    old.mkdir(parents=True)
    resource = old / "fixture"
    resource.write_text("fixture\n")

    code = (
        "import sys, ctypes, time\n"
        "f = open(sys.stdin.readline().strip())\n"
        "assert ctypes.CDLL(None).prctl(4, 0, 0, 0, 0) == 0\n"
        "print('ready', flush=True)\n"
        "time.sleep(30)\n"
    )
    reader = subprocess.Popen(
        [sys.executable, "-c", code],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        text=True,
    )
    try:
        reader.stdin.write(f"{resource}\n")
        reader.stdin.flush()
        assert reader.stdout.readline().strip() == "ready"

        script = f"""
        process.env.CODEX_RUNTIME_DIR = {json.dumps(str(runtime))};
        let inspectionError = null;
        try {{
          await (await import('node:fs/promises')).readdir('/proc/{reader.pid}/fd');
        }} catch(e) {{
          inspectionError = e.code;
        }}
        const gcRes = await mgr.cleanupOldReleases('0.163.0', null);
        const preserved = (await import('node:fs')).existsSync({json.dumps(str(resource))});
        console.log(JSON.stringify({{ inspectionError, gcRes, preserved }}));
        """
        res = run_node_eval(script, repository_root)
        assert res["inspectionError"] in ["EACCES", "EPERM"]
        assert res["gcRes"]["deferred"] is True
        assert res["gcRes"]["reason"] == "process_inspection_uncertain"
        assert res["preserved"] is True
        assert resource.exists()
    finally:
        reader.terminate()
        reader.wait()


def test_cleanup_old_releases_handles_process_exit_race(
    repository_root: Path, tmp_path: Path
) -> None:
    runtime = tmp_path / "runtime"
    releases = runtime / "releases"
    old = releases / "0.160.0-x86_64-unknown-linux-musl"
    current = releases / "0.163.0-x86_64-unknown-linux-musl"
    old.mkdir(parents=True)
    current.mkdir(parents=True)
    (runtime / "current").symlink_to(current)

    proc_dir = tmp_path / "proc"
    proc_dir.mkdir(parents=True)
    # Simulate a process that existed when readdir was called, but died before inspection (dangling symlink -> ENOENT)
    (proc_dir / "99999").symlink_to(tmp_path / "dead-proc")

    script = f"""
    process.env.CODEX_RUNTIME_DIR = {json.dumps(str(runtime))};
    process.env.CODEX_PROC_DIR = {json.dumps(str(proc_dir))};
    const gcRes = await mgr.cleanupOldReleases('0.163.0', null);
    const oldExists = (await import('node:fs')).existsSync({json.dumps(str(old))});
    console.log(JSON.stringify({{ gcRes, oldExists }}));
    """
    res = run_node_eval(script, repository_root)
    assert res["gcRes"]["deferred"] is not True
    assert res["oldExists"] is False
    assert not old.exists()


def test_cleanup_old_releases_preserves_live_cwd_and_mmap(
    repository_root: Path, tmp_path: Path
) -> None:
    runtime = tmp_path / "runtime"
    releases = runtime / "releases"
    rel_cwd = releases / "0.159.0-x86_64-unknown-linux-musl"
    rel_map = releases / "0.160.0-x86_64-unknown-linux-musl"
    current = releases / "0.163.0-x86_64-unknown-linux-musl"
    rel_cwd.mkdir(parents=True)
    rel_map.mkdir(parents=True)
    current.mkdir(parents=True)
    (runtime / "current").symlink_to(current)

    proc_dir = tmp_path / "proc"
    proc_dir.mkdir(parents=True)

    # Process 1001 has cwd pointing to rel_cwd
    p1 = proc_dir / "1001"
    p1.mkdir()
    (p1 / "cwd").symlink_to(rel_cwd)
    (p1 / "exe").symlink_to(Path("/bin/sh"))
    (p1 / "fd").mkdir()
    (p1 / "maps").write_text("")
    (p1 / "cmdline").write_text("")

    # Process 1002 has maps mapping a file in rel_map
    p2 = proc_dir / "1002"
    p2.mkdir()
    (p2 / "cwd").symlink_to(Path("/tmp"))
    (p2 / "exe").symlink_to(Path("/bin/sh"))
    (p2 / "fd").mkdir()
    (p2 / "maps").write_text(f"7f8a000-7f8b000 r-xp 0000 00:00 123 {rel_map}/lib/foo.so\n")
    (p2 / "cmdline").write_text("")

    script = f"""
    process.env.CODEX_RUNTIME_DIR = {json.dumps(str(runtime))};
    process.env.CODEX_PROC_DIR = {json.dumps(str(proc_dir))};
    const gcRes = await mgr.cleanupOldReleases('0.163.0', null);
    const cwdExists = (await import('node:fs')).existsSync({json.dumps(str(rel_cwd))});
    const mapExists = (await import('node:fs')).existsSync({json.dumps(str(rel_map))});
    console.log(JSON.stringify({{ gcRes, cwdExists, mapExists }}));
    """
    res = run_node_eval(script, repository_root)
    assert res["cwdExists"] is True
    assert res["mapExists"] is True
    assert rel_cwd.exists()
    assert rel_map.exists()



# --- task 004: process classification fixtures (helper vs real CLI vs server) ---

MOCK_APP_SERVER_JS = """
import net from 'node:net';
import crypto from 'node:crypto';
import fs from 'node:fs';

process.on('SIGHUP', () => process.exit(0));
let buf = Buffer.alloc(0);
const server = net.createServer((socket) => {
  socket.on('data', (data) => {
    const text = data.toString('utf-8');
    if (text.includes('Upgrade: websocket')) {
      const keyMatch = text.match(/Sec-WebSocket-Key: ([^\\r\\n]+)/);
      const key = keyMatch ? keyMatch[1].trim() : '';
      const accept = crypto.createHash('sha1')
        .update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11')
        .digest('base64');
      socket.write(
        'HTTP/1.1 101 Switching Protocols\\r\\n' +
        'Upgrade: websocket\\r\\n' +
        'Connection: Upgrade\\r\\n' +
        'Sec-WebSocket-Accept: ' + accept + '\\r\\n\\r\\n'
      );
      return;
    }
    buf = Buffer.concat([buf, data]);
    while (buf.length >= 2) {
      const b1 = buf[1];
      const isMasked = (b1 & 0x80) !== 0;
      let len = b1 & 0x7f;
      let offset = 2;
      if (len === 126) { if (buf.length < 4) break; len = buf.readUInt16BE(2); offset = 4; }
      else if (len === 127) { if (buf.length < 10) break; len = Number(buf.readBigUInt64BE(2)); offset = 10; }
      let maskKey = null;
      if (isMasked) { if (buf.length < offset + 4) break; maskKey = buf.slice(offset, offset + 4); offset += 4; }
      if (buf.length < offset + len) break;
      const payload = Buffer.from(buf.slice(offset, offset + len));
      buf = buf.slice(offset + len);
      if (maskKey) { for (let i = 0; i < len; i++) payload[i] ^= maskKey[i % 4]; }
      try {
        const msg = JSON.parse(payload.toString('utf-8'));
        let result = {};
        if (msg.method === 'initialize') result = { serverInfo: { name: 'mock-004' } };
        else if (msg.method === 'server/diagnostics') result = {
          process: { id: process.pid },
          gauges: [
            { name: 'app.requests.in_flight', value: 0 },
            { name: 'app.requests.queued', value: 0 },
            { name: 'core.turns.active', value: 0 }
          ]
        };
        else if (msg.method === 'thread/loaded/list') result = { data: [] };
        else if (msg.method === 'initialized') continue;
        const respPayload = Buffer.from(JSON.stringify({ id: msg.id, result }));
        let header;
        if (respPayload.length < 126) header = Buffer.from([0x81, respPayload.length]);
        else { header = Buffer.alloc(4); header[0] = 0x81; header[1] = 126; header.writeUInt16BE(respPayload.length, 2); }
        socket.write(Buffer.concat([header, respPayload]));
      } catch (e) {}
    }
  });
});
try { fs.unlinkSync(SOCKET); } catch {}
server.listen(SOCKET, () => console.log('READY'));
""".replace("SOCKET", "{socket!r}")


def _start_mock_server(socket_path: Path, launcher: Path, extra_listen_arg: bool = False) -> subprocess.Popen:
    launcher.parent.mkdir(parents=True, exist_ok=True)
    launcher.write_text(
        "#!/usr/bin/env node\n" + MOCK_APP_SERVER_JS.replace("{socket!r}", repr(str(socket_path))),
        encoding="utf-8",
    )
    launcher.chmod(0o755)
    listen = f"--listen=unix://{socket_path}" if extra_listen_arg else f"unix://{socket_path}"
    args = [str(launcher), "app-server"] + ([listen] if extra_listen_arg else ["--listen", listen])
    proc = subprocess.Popen(args, stdout=subprocess.PIPE, text=True)
    assert "READY" in proc.stdout.readline()
    return proc


def _register_session(maint_dir: Path, proc_pid: int, record: dict) -> None:
    stat_parts = Path(f"/proc/{proc_pid}/stat").read_text().rsplit(")", 1)[1].split()
    sessions_dir = maint_dir / "sessions"
    sessions_dir.mkdir(parents=True, exist_ok=True)
    full = {"pid": proc_pid, "start": stat_parts[19], **record}
    (sessions_dir / str(proc_pid)).write_text(json.dumps(full), encoding="utf-8")


def _inspect(repository_root: Path, runtime_dir: Path, maint_dir: Path, baseline_dir: Path | None = None) -> dict:
    baseline_line = f"process.env.CODEX_BASELINE_DIR = '{baseline_dir}';" if baseline_dir else ""
    script = f"""
    process.env.CODEX_RUNTIME_DIR = '{runtime_dir}';
    process.env.CODEX_MAINTENANCE_DIR = '{maint_dir}';
    {baseline_line}
    const res = await mgr.inspectAllSessions();
    res.busyReasons = res.busyReasons;
    console.log(JSON.stringify(res));
    """
    return run_node_eval(script, repository_root)


def test_unrelated_process_with_codex_argv_data_is_not_a_session(repository_root: Path, tmp_path: Path) -> None:
    runtime_dir = tmp_path / "runtime"
    maint_dir = tmp_path / "maint"
    runtime_dir.mkdir()
    maint_dir.mkdir()
    release_bin = runtime_dir / "releases" / "0.99.0-x86_64-unknown-linux-musl" / "bin" / "codex"
    decoys = [
        # codex paths and 'app-server' appear only as argv data, never as an exec identity
        subprocess.Popen(["python3", "-c", "import time; time.sleep(60)",
                          "/usr/local/bin/codex", "app-server", str(release_bin)]),
        subprocess.Popen(["bash", "-c", f'cd "{runtime_dir}" && echo /usr/local/bin/codex app-server && sleep 60']),
        subprocess.Popen(["grep", "-r", "app-server codex-real", str(tmp_path)]),
    ]
    try:
        time.sleep(0.2)
        res = _inspect(repository_root, runtime_dir, maint_dir)
        assert res["isIdle"] is True, res["busyReasons"]
        assert res["busyReasons"] == []
        assert res["sessionCount"] == 0
    finally:
        for d in decoys:
            d.terminate()
            d.wait()


def test_registered_cli_counted_once_with_cli_reason(repository_root: Path, tmp_path: Path) -> None:
    runtime_dir = tmp_path / "runtime"
    maint_dir = tmp_path / "maint"
    runtime_dir.mkdir()
    maint_dir.mkdir()
    _register_session(maint_dir, os.getpid(), {"type": "cli", "managed": False, "socketPath": ""})
    res = _inspect(repository_root, runtime_dir, maint_dir)
    assert res["isIdle"] is False
    assert res["sessionCount"] == 1
    assert len(res["busyReasons"]) == 1
    assert f"pid {os.getpid()}" in res["busyReasons"][0]
    assert res["blockers"][0]["type"] == "cli"
    assert res["counts"]["cli"] == 1
    assert res["canApply"] is False


def test_option_value_app_server_string_is_cli_not_remote_stdio(repository_root: Path, tmp_path: Path) -> None:
    runtime_dir = tmp_path / "runtime"
    maint_dir = tmp_path / "maint"
    runtime_dir.mkdir()
    maint_dir.mkdir()
    proc = subprocess.Popen([
        "python3", "-c", "import time; time.sleep(60)",
        "-c", "mcp_servers.playwright.tools.app-server.mode=\"prompt\"",
        "--add-dir", "/data/codex-ha-memory", "exec", "hello",
    ])
    try:
        _register_session(maint_dir, proc.pid, {
            "type": "cli", "managed": False, "socketPath": "",
            "exe": "/usr/local/libexec/codex-real",
            "args": ["-c", "mcp_servers.playwright.tools.app-server.mode=\"prompt\"",
                     "--add-dir", "/data/codex-ha-memory", "exec", "hello"],
        })
        res = _inspect(repository_root, runtime_dir, maint_dir)
        assert res["blockers"][0]["type"] == "cli", res["busyReasons"]
        assert res["counts"]["remoteStdio"] == 0
        assert res["sessionCount"] == 1
    finally:
        proc.terminate()
        proc.wait()


def test_parse_codex_invocation_subcommand_and_listen_forms(repository_root: Path) -> None:
    script = """
    const bin = '/data/codex-runtime/releases/0.163.0-x86_64-unknown-linux-musl/bin/codex';
    const cases = [
      mgr.parseCodexInvocation([bin, 'app-server', '--listen', 'unix:///x.sock']),
      mgr.parseCodexInvocation([bin, '--listen=unix:///y.sock', 'app-server']),
      mgr.parseCodexInvocation([bin, '-c', 'approval_policy=\"on-request\"', '--add-dir', '/data/codex-ha-memory', '-c', 'mcp_servers.playwright.tools.browser_click.approval_mode=\"approve\"', 'app-server', '--listen', 'unix:///z.sock']),
      mgr.parseCodexInvocation([bin, '-c', 'mcp.playwright.tools.app-server.mode=\"prompt\"', 'exec', 'hello app-server update']),
      mgr.parseCodexInvocation([bin, '--', 'app-server']),
      mgr.parseCodexInvocation([bin]),
    ];
    console.log(JSON.stringify(cases));
    """
    cases = run_node_eval(script, repository_root)
    assert cases[0] == {"subcommand": "app-server", "listenSocket": "/x.sock"}
    assert cases[1] == {"subcommand": "app-server", "listenSocket": "/y.sock"}
    assert cases[2] == {"subcommand": "app-server", "listenSocket": "/z.sock"}
    assert cases[3] == {"subcommand": "exec", "listenSocket": None}
    assert cases[4] == {"subcommand": None, "listenSocket": None}
    assert cases[5] == {"subcommand": None, "listenSocket": None}


def test_managed_idle_server_with_owned_companion_is_restartable(repository_root: Path, tmp_path: Path) -> None:
    runtime_dir = tmp_path / "runtime"
    maint_dir = tmp_path / "maint"
    runtime_dir.mkdir()
    maint_dir.mkdir()
    release = runtime_dir / "releases" / "0.162.1-x86_64-unknown-linux-musl"
    socket_path = tmp_path / "managed.sock"
    companion = release / "bin" / "codex-code-mode-host"
    companion.parent.mkdir(parents=True, exist_ok=True)
    companion.write_text("#!/usr/bin/env node\nsetTimeout(() => {}, 600000);\n", encoding="utf-8")
    companion.chmod(0o755)
    launcher = release / "bin" / "codex"
    launcher.write_text(
        "#!/usr/bin/env node\nimport { spawn } from 'node:child_process';\n"
        f"spawn({str(companion)!r}, [], {{ stdio: 'ignore' }});\n"
        + MOCK_APP_SERVER_JS.replace("{socket!r}", repr(str(socket_path))),
        encoding="utf-8",
    )
    launcher.chmod(0o755)
    proc = subprocess.Popen([str(launcher), "app-server", "--listen", f"unix://{socket_path}"],
                            stdout=subprocess.PIPE, text=True)
    try:
        assert "READY" in proc.stdout.readline()
        time.sleep(0.3)
        _register_session(maint_dir, proc.pid, {
            "type": "app-server", "managed": True, "socketPath": str(socket_path),
            "exe": str(launcher), "version": "0.162.1", "cwd": str(tmp_path),
            "args": ["app-server", "--listen", f"unix://{socket_path}"],
        })
        res = _inspect(repository_root, runtime_dir, maint_dir)
        assert res["busyReasons"] == [], res["busyReasons"]
        assert res["canApply"] is True
        assert res["isIdle"] is False
        assert len(res["restartableServers"]) == 1
        assert res["restartableServers"][0]["pid"] == proc.pid
        assert res["sessionCount"] == 1
        assert res["counts"]["helpers"] >= 1
        assert res["counts"]["cli"] == 0
    finally:
        stat_children = Path(f"/proc/{proc.pid}/task/{proc.pid}/children").read_text().split()
        proc.terminate()
        proc.wait()
        for child in stat_children:
            try:
                os.kill(int(child), 15)
            except (ProcessLookupError, ValueError):
                pass


def test_managed_server_listen_equals_form_is_restartable(repository_root: Path, tmp_path: Path) -> None:
    runtime_dir = tmp_path / "runtime"
    maint_dir = tmp_path / "maint"
    runtime_dir.mkdir()
    maint_dir.mkdir()
    baseline = tmp_path / "baseline"
    socket_path = tmp_path / "eq.sock"
    launcher = baseline / "bin" / "codex"
    proc = _start_mock_server(socket_path, launcher, extra_listen_arg=True)
    try:
        _register_session(maint_dir, proc.pid, {
            "type": "app-server", "managed": True, "socketPath": str(socket_path),
            "exe": str(launcher), "version": "0.162.1", "cwd": str(tmp_path),
            "args": ["app-server", f"--listen=unix://{socket_path}"],
        })
        res = _inspect(repository_root, runtime_dir, maint_dir, baseline_dir=baseline)
        assert res["counts"]["remoteStdio"] == 0, res["busyReasons"]
        assert len(res["restartableServers"]) == 1
        assert res["canApply"] is True
    finally:
        proc.terminate()
        proc.wait()


def test_orphan_companion_holds_conservatively_as_unknown(repository_root: Path, tmp_path: Path) -> None:
    runtime_dir = tmp_path / "runtime"
    maint_dir = tmp_path / "maint"
    runtime_dir.mkdir()
    maint_dir.mkdir()
    release = runtime_dir / "releases" / "0.162.1-x86_64-unknown-linux-musl"
    companion = release / "bin" / "codex-code-mode-host"
    companion.parent.mkdir(parents=True, exist_ok=True)
    companion.write_text("#!/usr/bin/env node\nsetTimeout(() => {}, 600000);\n", encoding="utf-8")
    companion.chmod(0o755)
    proc = subprocess.Popen([str(companion)], stdout=subprocess.DEVNULL)
    try:
        time.sleep(0.2)
        res = _inspect(repository_root, runtime_dir, maint_dir)
        assert res["isIdle"] is False
        assert res["counts"]["cli"] == 0
        assert res["blockers"][0]["type"] == "unknown", res["busyReasons"]
        assert res["canApply"] is False
    finally:
        proc.terminate()
        proc.wait()


def test_status_exposes_process_summary_and_dedicated_labels(repository_root: Path, tmp_path: Path) -> None:
    runtime_dir = tmp_path / "runtime"
    maint_dir = tmp_path / "maint"
    runtime_dir.mkdir()
    maint_dir.mkdir()
    _register_session(maint_dir, os.getpid(), {"type": "cli", "managed": False, "socketPath": ""})
    script = f"""
    process.env.CODEX_RUNTIME_DIR = '{runtime_dir}';
    process.env.CODEX_MAINTENANCE_DIR = '{maint_dir}';
    await mgr.initRuntime();
    const status = await mgr.getStatus();
    console.log(JSON.stringify(status));
    """
    status = run_node_eval(script, repository_root)
    assert status["activeSessions"] == 1  # compatibility field kept
    assert status["processSummary"]["cli"] == 1
    assert status["processSummary"]["managedIdleServers"] == 0
    assert status["canApply"] is False
    assert status["isIdle"] is False

    proc = subprocess.run(
        ["node", "codex_home_assistant/rootfs/usr/local/share/codex-ha/codex-runtime-manager.mjs", "status"],
        cwd=repository_root,
        capture_output=True,
        text=True,
        env={**os.environ, "CODEX_RUNTIME_DIR": str(runtime_dir), "CODEX_MAINTENANCE_DIR": str(maint_dir)},
    )
    assert proc.returncode == 0, proc.stderr
    assert "Codex processes" in proc.stdout
    assert "Active sessions" not in proc.stdout


def test_wrapper_subcommand_block_matches_runtime_parser(repository_root: Path) -> None:
    wrapper = (repository_root / "codex_home_assistant/rootfs/usr/local/bin/codex").read_text(encoding="utf-8")
    start = wrapper.index('codex_subcommand=""')
    end = wrapper.index('socket_path="${codex_listen}"')
    end = wrapper.index("fi", end) + 2
    block = wrapper[start:end]

    harness = f"""
    run_case() {{
      local codex_subcommand="" codex_listen="" options_ended=false idx=0
      local args=("$@") token
      {block}
      echo "sub=${{codex_subcommand}};listen=${{codex_listen}};app=${{is_app_server}}"
    }}
    run_case app-server --listen unix:///x.sock
    run_case app-server --listen=unix:///y.sock
    run_case -c 'approval_policy="on-request"' --add-dir /data/codex-ha-memory app-server --listen unix:///z.sock
    run_case -c 'mcp.playwright.tools.app-server.mode="prompt"' exec hello
    run_case -- app-server
    run_case
    run_case exec 'update my lights'
    """
    proc = subprocess.run(["bash", "-c", harness], capture_output=True, text=True)
    assert proc.returncode == 0, proc.stderr
    lines = proc.stdout.strip().splitlines()
    assert lines[0] == "sub=app-server;listen=unix:///x.sock;app=true"
    assert lines[1] == "sub=app-server;listen=unix:///y.sock;app=true"
    assert lines[2] == "sub=app-server;listen=unix:///z.sock;app=true"
    assert lines[3] == "sub=exec;listen=;app=false"
    assert lines[4] == "sub=;listen=;app=false"
    assert lines[5] == "sub=;listen=;app=false"
    assert lines[6] == "sub=exec;listen=;app=false"


# --- task 004 FIX_01 regression fixtures (F1 unknown package exe, F2 lastBlocker, F3 option vectors) ---

def test_unrecognized_package_executable_is_held_unknown(repository_root: Path, tmp_path: Path) -> None:
    runtime_dir = tmp_path / "runtime"
    sibling_dir = tmp_path / "runtime-sibling"
    maint_dir = tmp_path / "maint"
    (runtime_dir / "releases").mkdir(parents=True)
    sibling_dir.mkdir()
    maint_dir.mkdir()

    real_node = shutil.which("node")
    baseline = tmp_path / "baseline"
    (baseline / "bin").mkdir(parents=True)
    unknown_baseline = baseline / "bin" / "codex-future-helper"
    shutil.copy(real_node, unknown_baseline)

    rel = runtime_dir / "releases" / "0.163.0-x86_64-unknown-linux-musl" / "bin"
    rel.mkdir(parents=True)
    unknown_release = rel / "codex-new-helper"
    shutil.copy(real_node, unknown_release)

    keep_alive = "setInterval(() => {}, 600000)"
    deleted_proc = subprocess.Popen([str(unknown_release), "-e", keep_alive],
                                    stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    unknown_release.unlink()  # exe becomes '<path> (deleted)'

    sibling_copy = sibling_dir / "releases" / "0.163.0-x" / "bin"
    sibling_copy.mkdir(parents=True)
    sibling_bin = sibling_copy / "codex-sibling"
    shutil.copy(real_node, sibling_bin)
    sibling_proc = subprocess.Popen([str(sibling_bin), "-e", keep_alive],
                                    stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

    procs = [deleted_proc, sibling_proc,
             subprocess.Popen([str(unknown_baseline), "-e", keep_alive],
                              stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)]
    try:
        time.sleep(0.2)
        res = _inspect(repository_root, runtime_dir, maint_dir, baseline_dir=baseline)
        types = [b["type"] for b in res["blockers"]]
        assert types.count("unknown") == 2, res["busyReasons"]
        assert res["counts"]["cli"] == 0
        assert res["counts"]["detectedProcesses"] == 2  # sibling path stays outside the boundary
        assert res["canApply"] is False
        assert res["isIdle"] is False
        for p in procs[:1] + procs[2:]:
            p.terminate()
            p.wait()
        # after the two unknown package processes exit, only the sibling path
        # (outside canonical boundaries) remains and must be ignored
        res2 = _inspect(repository_root, runtime_dir, maint_dir, baseline_dir=baseline)
        assert res2["isIdle"] is True, res2["busyReasons"]
        assert res2["canApply"] is True
        assert res2["counts"]["unknown"] == 0
    finally:
        for p in procs:
            p.terminate()
            p.wait()


def test_last_blocker_round_trips_and_sanitizes(repository_root: Path, tmp_path: Path) -> None:
    runtime_dir = tmp_path / "runtime"
    maint_dir = tmp_path / "maint"
    runtime_dir.mkdir()
    maint_dir.mkdir()
    script = f"""
    process.env.CODEX_RUNTIME_DIR = '{runtime_dir}';
    process.env.CODEX_MAINTENANCE_DIR = '{maint_dir}';
    await mgr.initRuntime();
    await mgr.updateState(s => {{ s.status = 'pending_busy'; s.lastBlocker = 'remote_stdio'; }});
    const state = await mgr.loadState();
    console.log(JSON.stringify({{ state }}));
    """
    res = run_node_eval(script, repository_root)
    assert res["state"]["lastBlocker"] == "remote_stdio"

    # cross-process read via the real status command
    proc = subprocess.run(
        ["node", "codex_home_assistant/rootfs/usr/local/share/codex-ha/codex-runtime-manager.mjs", "status", "--json"],
        cwd=repository_root,
        capture_output=True,
        text=True,
        env={**os.environ, "CODEX_RUNTIME_DIR": str(runtime_dir), "CODEX_MAINTENANCE_DIR": str(maint_dir)},
    )
    assert proc.returncode == 0, proc.stderr
    status = json.loads(proc.stdout)
    assert status["lastBlocker"] == "remote_stdio"
    assert "lastBlocker" in json.dumps(json.loads((runtime_dir / "state.json").read_text()))

    script2 = f"""
    process.env.CODEX_RUNTIME_DIR = '{runtime_dir}';
    process.env.CODEX_MAINTENANCE_DIR = '{maint_dir}';
    await mgr.updateState(s => {{ s.lastBlocker = 'raw /home/user/secret note'; }});
    const rejected = await mgr.loadState();
    const fileText = await (await import('node:fs/promises')).readFile('{runtime_dir}/state.json', 'utf-8');
    await mgr.updateState(s => {{ s.lastBlocker = null; }});
    const cleared = await mgr.loadState();
    console.log(JSON.stringify({{ rejected: rejected.lastBlocker, leak: fileText.includes('raw /home/user/secret'), cleared: cleared.lastBlocker }}));
    """
    res2 = run_node_eval(script2, repository_root)
    assert res2["rejected"] is None  # unlisted text never persists
    assert res2["leak"] is False
    assert res2["cleared"] is None


def test_budget_paused_busy_keeps_process_blocker_type(repository_root: Path, tmp_path: Path) -> None:
    runtime_dir = tmp_path / "runtime"
    maint_dir = tmp_path / "maint"
    runtime_dir.mkdir()
    sessions_dir = maint_dir / "sessions"
    sessions_dir.mkdir(parents=True)
    options_file = tmp_path / "options.json"
    options_file.write_text(json.dumps({"codex_auto_update_timezone": "UTC"}), encoding="utf-8")
    _register_session(maint_dir, os.getpid(), {"type": "cli", "managed": False, "socketPath": ""})

    script = f"""
    process.env.CODEX_RUNTIME_DIR = '{runtime_dir}';
    process.env.CODEX_MAINTENANCE_DIR = '{maint_dir}';
    process.env.CODEX_HA_OPTIONS_FILE = '{options_file}';
    process.env.CODEX_TEST_CLOCK = '2026-10-13T10:00:00Z';
    await mgr.initRuntime();
    const candidateDir = mgr.getReleasesDir() + '/0.163.0-x86_64-unknown-linux-musl';
    await (await import('node:fs/promises')).mkdir(candidateDir + '/bin', {{ recursive: true }});
    await (await import('node:fs/promises')).writeFile(candidateDir + '/bin/codex', '#!/bin/sh\\necho codex-cli 0.163.0\\n');
    await (await import('node:fs/promises')).chmod(candidateDir + '/bin/codex', 0o755);
    await (await import('node:fs/promises')).writeFile(candidateDir + '/codex-package.json',
      JSON.stringify({{ version: '0.163.0', target: 'x86_64-unknown-linux-musl', entrypoint: 'bin/codex' }}));
    await sealFixture(candidateDir);
    await (await import('node:fs/promises')).symlink(candidateDir, mgr.getStagedLink());
    await mgr.updateState(s => {{ s.stagedVersion = '0.163.0'; s.status = 'ready_to_apply'; }});
    const results = [];
    for (let i = 0; i < 13; i++) {{
      const r = await mgr.applyUpdate();
      const st = await mgr.loadState();
      results.push({{ reason: r.reason, lastBlocker: st.lastBlocker, status: st.status }});
    }}
    console.log(JSON.stringify(results));
    """
    results = run_node_eval(script, repository_root)
    assert all(r["lastBlocker"] == "cli" for r in results[:11]), results
    assert results[11]["status"] == "paused_busy"
    assert results[11]["lastBlocker"] == "cli"
    assert results[12]["reason"] == "paused_busy"
    assert results[12]["lastBlocker"] == "cli"
    assert results[11]["reason"] == "paused_busy"


def test_parse_codex_invocation_real_release_global_options(repository_root: Path) -> None:
    script = """
    const bin = '/usr/local/lib/codex-ha/codex-baseline/bin/codex';
    const cases = [
      mgr.parseCodexInvocation([bin, '-p', 'home', 'app-server', '--listen', 'unix:///tmp/review.sock']),
      mgr.parseCodexInvocation([bin, '-a', 'never', 'exec', 'hello']),
      mgr.parseCodexInvocation([bin, '--enable', 'web_search', '--disable', 'beta', 'app-server', '--listen', 'unix:///x']),
      mgr.parseCodexInvocation([bin, '--profile', 'home', 'app-server']),
      mgr.parseCodexInvocation([bin, '--remote', 'ws://127.0.0.1:1', 'app-server']),
      mgr.parseCodexInvocation([bin, '--remote-auth-token-env', 'RT', '-i', 'shot.png', 'app-server']),
      mgr.parseCodexInvocation([bin, '-p', 'app-server', 'exec', 'hi']),
    ];
    console.log(JSON.stringify(cases));
    """
    cases = run_node_eval(script, repository_root)
    assert cases[0]["subcommand"] == "app-server" and cases[0]["listenSocket"] == "/tmp/review.sock"
    assert cases[1]["subcommand"] == "exec"
    assert cases[2]["subcommand"] == "app-server" and cases[2]["listenSocket"] == "/x"
    assert cases[3]["subcommand"] == "app-server"
    assert cases[4]["subcommand"] == "app-server"
    assert cases[5]["subcommand"] == "app-server"
    # -p consumes 'app-server' as its value; first remaining positional is exec -> conservative CLI
    assert cases[6]["subcommand"] == "exec"


def test_wrapper_blocks_handle_real_release_global_options(repository_root: Path) -> None:
    wrapper = (repository_root / "codex_home_assistant/rootfs/usr/local/bin/codex").read_text(encoding="utf-8")

    start = wrapper.index('codex_subcommand=""')
    end = wrapper.index('socket_path="${codex_listen}"')
    end = wrapper.index("fi", end) + 2
    block = wrapper[start:end]
    harness = f"""
    run_case() {{
      local codex_subcommand="" codex_listen="" options_ended=false idx=0
      local args=("$@") token
      {block}
      echo "sub=${{codex_subcommand}};listen=${{codex_listen}};app=${{is_app_server}}"
    }}
    run_case -p home app-server --listen unix:///tmp/review.sock
    run_case -a never exec hello
    run_case --enable web_search --disable beta app-server --listen=unix:///x.sock
    run_case --remote-auth-token-env RT -i shot.png app-server
    """
    proc = subprocess.run(["bash", "-c", harness], capture_output=True, text=True)
    assert proc.returncode == 0, proc.stderr
    lines = proc.stdout.strip().splitlines()
    assert lines[0] == "sub=app-server;listen=unix:///tmp/review.sock;app=true"
    assert lines[1] == "sub=exec;listen=;app=false"
    assert lines[2] == "sub=app-server;listen=unix:///x.sock;app=true"
    assert lines[3] == "sub=app-server;listen=;app=true"

    # update routing must not leak a valid global-option invocation to the real binary
    up_start = wrapper.index("is_update_subcommand=false")
    up_end = wrapper.index("if [[ \"${is_update_subcommand}\" == true ]]; then")
    up_block = wrapper[up_start:up_end]
    up_harness = f"""
    route_case() {{
      local {up_block}
      echo "update=${{is_update_subcommand}}"
    }}
    route_case -p home update --status
    route_case -a never update
    route_case --remote ws://host update status
    """
    proc2 = subprocess.run(["bash", "-c", up_harness], capture_output=True, text=True)
    assert proc2.returncode == 0, proc2.stderr + proc2.stdout
    up_lines = proc2.stdout.strip().splitlines()
    assert up_lines[0] == "update=true"
    assert up_lines[1] == "update=true"
    assert up_lines[2] == "update=true"


def test_managed_server_with_global_option_prefix_is_restartable(repository_root: Path, tmp_path: Path) -> None:
    runtime_dir = tmp_path / "runtime"
    maint_dir = tmp_path / "maint"
    runtime_dir.mkdir()
    maint_dir.mkdir()
    baseline = tmp_path / "baseline"
    socket_path = tmp_path / "optpref.sock"
    launcher = baseline / "bin" / "codex"
    launcher.parent.mkdir(parents=True, exist_ok=True)
    launcher.write_text(
        "#!/usr/bin/env node\n"
        "if (process.argv.includes('--version')) { console.log('codex-cli 0.162.1'); process.exit(0); }\n"
        + MOCK_APP_SERVER_JS.replace("{socket!r}", repr(str(socket_path))),
        encoding="utf-8",
    )
    launcher.chmod(0o755)
    proc = subprocess.Popen([str(launcher), "-p", "home", "app-server", "--listen", f"unix://{socket_path}"],
                            stdout=subprocess.PIPE, text=True)
    try:
        assert "READY" in proc.stdout.readline()
        _register_session(maint_dir, proc.pid, {
            "type": "app-server", "managed": True, "socketPath": str(socket_path),
            "exe": str(launcher), "version": "0.162.1", "cwd": str(tmp_path),
            "args": ["-p", "home", "app-server", "--listen", f"unix://{socket_path}"],
        })
        res = _inspect(repository_root, runtime_dir, maint_dir, baseline_dir=baseline)
        assert res["counts"]["remoteStdio"] == 0, res["busyReasons"]
        assert res["counts"]["cli"] == 0, res["busyReasons"]
        assert len(res["restartableServers"]) == 1
        assert res["canApply"] is True
    finally:
        proc.terminate()
        proc.wait()


def _get_proc_start_time(pid: int) -> str | None:
    try:
        stat_content = Path(f"/proc/{pid}/stat").read_text(encoding="utf-8")
        return stat_content.rsplit(")", 1)[1].split()[19]
    except (FileNotFoundError, ProcessLookupError, PermissionError, IndexError):
        return None


def _is_path_inside(child_path_str: str, parent_dir: Path) -> bool:
    if not child_path_str:
        return False
    try:
        p = Path(child_path_str).resolve()
        parent = parent_dir.resolve()
        return p == parent or p.is_relative_to(parent)
    except (ValueError, OSError):
        return False


@functools.lru_cache(maxsize=1)
def _get_known_interpreters() -> set[str]:
    interpreters: set[str] = set()
    if sys.executable:
        try:
            interpreters.add(os.path.realpath(sys.executable))
        except OSError:
            pass
    node_bin = shutil.which("node")
    if node_bin:
        try:
            interpreters.add(os.path.realpath(node_bin))
        except OSError:
            pass
    for candidate in ("/usr/bin/node", "/usr/local/bin/node", "/bin/node", "/usr/bin/python3", "/usr/local/bin/python3"):
        if os.path.exists(candidate):
            try:
                interpreters.add(os.path.realpath(candidate))
            except OSError:
                pass
    return interpreters


def _is_proc_running_inside_fixture(entry: Path, fixture_dir: Path) -> bool:
    try:
        # 1. Native executable inside fixture directory
        exe_path = entry / "exe"
        if not exe_path.exists():
            return False

        try:
            exe_target = os.readlink(exe_path)
        except OSError:
            return False

        if _is_path_inside(exe_target, fixture_dir):
            return True

        # 2. Confirmed Node/Python interpreter executing a script inside fixture directory
        exe_target_real = os.path.realpath(exe_target)
        known_interpreters = _get_known_interpreters()
        if exe_target_real not in known_interpreters:
            return False

        cmdline_path = entry / "cmdline"
        try:
            raw_cmdline = cmdline_path.read_bytes()
        except OSError:
            return False

        if not raw_cmdline:
            return False

        argv = [arg.decode("utf-8", "replace") for arg in raw_cmdline.split(b"\x00") if arg]
        # Must have at least interpreter and script path: argv[1]
        if len(argv) < 2:
            return False

        script_arg = argv[1]
        # Reject any interpreter option preceding the script (e.g. -c, -cCODE, -m, -e, --eval, -, etc.)
        if script_arg.startswith("-"):
            return False

        # Script must be inside canonical fixture_dir
        if not _is_path_inside(script_arg, fixture_dir):
            return False

        # Target script must be an actual regular file
        script_file = Path(script_arg)
        if not script_file.is_file():
            return False

        return True
    except (FileNotFoundError, ProcessLookupError, PermissionError):
        return False



def _find_fixture_processes_for_dir(fixture_dir: Path) -> list[tuple[int, str]]:
    """Return live fixture processes explicitly running inside fixture_dir with (pid, start_time)."""
    matches: list[tuple[int, str]] = []
    for entry in Path("/proc").iterdir():
        if not entry.name.isdigit():
            continue
        pid = int(entry.name)
        if pid == os.getpid():
            continue
        if _is_proc_running_inside_fixture(entry, fixture_dir):
            start_time = _get_proc_start_time(pid)
            if start_time is not None:
                matches.append((pid, start_time))
    return matches


def _verify_process_identity(pid: int, expected_start: str, fixture_dir: Path | None = None) -> bool:
    """Verify that PID is alive, matches expected start_time, and belongs to fixture_dir if specified."""
    curr_start = _get_proc_start_time(pid)
    if curr_start is None or curr_start != expected_start:
        return False
    if fixture_dir is not None:
        if not _is_proc_running_inside_fixture(Path(f"/proc/{pid}"), fixture_dir):
            return False
    return True


def _terminate_fixture_processes(
    tracked_identities: set[tuple[int, str]],
    fixture_dir: Path | None = None,
    direct_children: list[subprocess.Popen] | None = None,
    timeout: float = 5.0,
) -> None:
    """Bounded wait termination of fixture processes verified by PID+start_time."""
    identities: set[tuple[int, str]] = set(tracked_identities)
    if fixture_dir is not None:
        for ident in _find_fixture_processes_for_dir(fixture_dir):
            identities.add(ident)

    # Close stdout pipes of direct children and terminate
    if direct_children:
        for child in direct_children:
            try:
                if child.stdout:
                    child.stdout.close()
            except Exception:
                pass
            if child.poll() is None:
                try:
                    child.terminate()
                except ProcessLookupError:
                    pass

    # Send SIGTERM only after verifying PID + start_time (+ fixture boundary)
    for pid, start_time in list(identities):
        if _verify_process_identity(pid, start_time, fixture_dir):
            try:
                os.kill(pid, 15)
            except ProcessLookupError:
                identities.discard((pid, start_time))
        else:
            identities.discard((pid, start_time))

    # Wait for direct children to be reaped
    if direct_children:
        for child in direct_children:
            try:
                child.wait(timeout=2.0)
            except (subprocess.TimeoutExpired, ProcessLookupError):
                try:
                    child.kill()
                    child.wait(timeout=1.0)
                except Exception:
                    pass

    # Bounded wait for detached processes to exit
    deadline = time.monotonic() + timeout
    while identities and time.monotonic() < deadline:
        for pid, start_time in list(identities):
            if not _verify_process_identity(pid, start_time, fixture_dir):
                identities.discard((pid, start_time))
        if identities:
            time.sleep(0.05)

    # Force kill any stubborn fixture process only if identity still matches
    for pid, start_time in list(identities):
        if _verify_process_identity(pid, start_time, fixture_dir):
            try:
                os.kill(pid, 9)
            except ProcessLookupError:
                pass


def test_companion_server_real_replacement_preserves_old_generation_while_helper_lives(
    repository_root: Path, tmp_path: Path
) -> None:
    runtime_dir = tmp_path / "runtime"
    maint_dir = tmp_path / "maint"
    (runtime_dir / "releases").mkdir(parents=True)
    maint_dir.mkdir()
    baseline = tmp_path / "baseline"
    socket_path = tmp_path / "replace.sock"
    companion_file = tmp_path / "companion_pid"

    old_gen = runtime_dir / "releases" / "0.162.1-x86_64-unknown-linux-musl"
    new_gen = runtime_dir / "releases" / "0.163.0-x86_64-unknown-linux-musl"
    (old_gen / "bin").mkdir(parents=True)
    (new_gen / "bin").mkdir(parents=True)
    companion = old_gen / "bin" / "codex-code-mode-host"
    companion.write_text("#!/usr/bin/env node\nsetTimeout(() => {}, 600000);\n", encoding="utf-8")
    companion.chmod(0o755)
    old_bin = old_gen / "bin" / "codex"
    old_bin.write_text(
        "#!/usr/bin/env node\n"
        "if (process.argv.includes('--version')) { console.log('codex-cli 0.162.1'); process.exit(0); }\n"
        f"import {{ spawn }} from 'node:child_process';\n"
        f"const kid = spawn({str(companion)!r}, [], {{ stdio: 'ignore' }});\n"
        f"fs.writeFileSync({str(companion_file)!r}, String(kid.pid));\n"
        + MOCK_APP_SERVER_JS.replace("{socket!r}", repr(str(socket_path))),
        encoding="utf-8",
    )
    old_bin.chmod(0o755)
    new_bin = new_gen / "bin" / "codex"
    new_bin.write_text(
        "#!/usr/bin/env node\n"
        "if (process.argv.includes('--version')) { console.log('codex-cli 0.163.0'); process.exit(0); }\n"
        + MOCK_APP_SERVER_JS.replace("{socket!r}", repr(str(socket_path))),
        encoding="utf-8",
    )
    new_bin.chmod(0o755)
    (old_gen / "codex-package.json").write_text(json.dumps({"version": "0.162.1", "target": "x86_64-unknown-linux-musl", "entrypoint": "bin/codex"}))
    (new_gen / "codex-package.json").write_text(json.dumps({"version": "0.163.0", "target": "x86_64-unknown-linux-musl", "entrypoint": "bin/codex"}))

    tracked_identities: set[tuple[int, str]] = set()
    proc: subprocess.Popen | None = None
    try:
        proc = subprocess.Popen([str(old_bin), "app-server", "--listen", f"unix://{socket_path}"],
                                stdout=subprocess.PIPE, text=True)
        old_start = _get_proc_start_time(proc.pid)
        if old_start:
            tracked_identities.add((proc.pid, old_start))
        line = proc.stdout.readline()
        assert "READY" in line

        deadline = time.monotonic() + 3.0
        while not companion_file.exists() and time.monotonic() < deadline:
            time.sleep(0.05)
        assert companion_file.exists(), "companion PID file not created"
        helper_pid = int(companion_file.read_text().strip())
        helper_start = _get_proc_start_time(helper_pid)
        if helper_start:
            tracked_identities.add((helper_pid, helper_start))

        _register_session(maint_dir, proc.pid, {
            "type": "app-server", "managed": True, "socketPath": str(socket_path),
            "exe": str(old_bin), "version": "0.162.1", "cwd": str(tmp_path),
            "args": ["app-server", "--listen", f"unix://{socket_path}"],
        })

        script = f"""
        process.env.CODEX_RUNTIME_DIR = '{runtime_dir}';
        process.env.CODEX_MAINTENANCE_DIR = '{maint_dir}';
        process.env.CODEX_BASELINE_DIR = '{baseline}';
        await (await import('node:fs/promises')).mkdir('{baseline}', {{ recursive: true }});
        await mgr.initRuntime();
        await sealFixture('{new_gen}');
        await (await import('node:fs/promises')).symlink('{new_gen}', mgr.getStagedLink());
        await mgr.updateState(s => {{ s.stagedVersion = '0.163.0'; s.candidateVersion = '0.163.0'; s.status = 'ready_to_apply'; }});
        const before = await mgr.inspectAllSessions();
        const applied = await mgr.applyUpdate({{ policyProbe: async () => ({{ valid: true }}) }});
        const state = await mgr.loadState();
        const after = await mgr.inspectAllSessions();
        console.log(JSON.stringify({{
          beforeRestartable: before.restartableServers.map(s => s.pid),
          beforeBusy: before.busyReasons,
          applied: applied.applied, reason: applied.reason, version: applied.version,
          selected: state.selectedVersion, lastBlocker: state.lastBlocker,
          afterBusy: after.busyReasons, afterTypes: after.blockers.map(b => b.type),
          afterRestartable: after.restartableServers.map(s => s.pid),
          afterCounts: after.counts, canApply: after.canApply
        }}));
        """
        res = run_node_eval(script, repository_root)
        for srv in res.get("afterRestartable", []):
            spid = srv if isinstance(srv, int) else srv.get("pid")
            if spid:
                s_start = _get_proc_start_time(spid)
                if s_start:
                    tracked_identities.add((spid, s_start))

        assert res["beforeBusy"] == [], res["beforeBusy"]
        assert len(res["beforeRestartable"]) == 1 and res["beforeRestartable"][0] == proc.pid
        assert res["applied"] is True, res["reason"]
        assert res["version"] == "0.163.0"
        assert res["selected"] == "0.163.0"
        assert res["lastBlocker"] is None
        assert proc.wait(timeout=5) is not None  # old server exited gracefully (reaped)
        # the surviving old-generation helper is unattributed -> unknown hold, not a CLI
        assert res["afterTypes"] == ["unknown"], res["afterBusy"]
        assert res["afterCounts"]["cli"] == 0
        assert res["canApply"] is False
        # new server restartable on the same socket, different pid
        assert len(res["afterRestartable"]) == 1
        assert res["afterRestartable"][0] != proc.pid
        # old generation still referenced by the live helper exe -> preserved
        assert old_gen.exists()
    finally:
        sessions_dir = maint_dir / "sessions"
        if sessions_dir.exists():
            for sf in sessions_dir.iterdir():
                if sf.name.isdigit():
                    try:
                        record = json.loads(sf.read_text(encoding="utf-8"))
                        r_pid = int(record["pid"])
                        r_start = record.get("start") or _get_proc_start_time(r_pid)
                        if r_start:
                            tracked_identities.add((r_pid, str(r_start)))
                    except Exception:
                        pass

        _terminate_fixture_processes(
            tracked_identities=tracked_identities,
            fixture_dir=tmp_path,
            direct_children=[proc] if proc is not None else None,
        )
        surviving = _find_fixture_processes_for_dir(tmp_path)
        assert surviving == [], f"surviving fixture processes: {surviving}"


def test_companion_server_setup_failure_teardown_leaves_zero_processes(
    repository_root: Path, tmp_path: Path
) -> None:
    """Verify that if setup or assertion fails, teardown reaps direct children and detached helpers."""
    socket_path = tmp_path / "fail.sock"
    companion_file = tmp_path / "companion_fail_pid"
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir(parents=True)
    companion = bin_dir / "codex-code-mode-host"
    companion.write_text("#!/usr/bin/env node\nsetTimeout(() => {}, 600000);\n", encoding="utf-8")
    companion.chmod(0o755)
    mock_bin = bin_dir / "codex"
    mock_bin.write_text(
        "#!/usr/bin/env node\n"
        f"import {{ spawn }} from 'node:child_process';\n"
        f"const kid = spawn({str(companion)!r}, [], {{ stdio: 'ignore' }});\n"
        f"fs.writeFileSync({str(companion_file)!r}, String(kid.pid));\n"
        + MOCK_APP_SERVER_JS.replace("{socket!r}", repr(str(socket_path))),
        encoding="utf-8",
    )
    mock_bin.chmod(0o755)

    tracked_identities: set[tuple[int, str]] = set()
    proc: subprocess.Popen | None = None
    failed_as_expected = False
    try:
        proc = subprocess.Popen([str(mock_bin), "app-server", "--listen", f"unix://{socket_path}"],
                                stdout=subprocess.PIPE, text=True)
        old_start = _get_proc_start_time(proc.pid)
        if old_start:
            tracked_identities.add((proc.pid, old_start))
        line = proc.stdout.readline()
        assert "READY" in line

        deadline = time.monotonic() + 3.0
        while not companion_file.exists() and time.monotonic() < deadline:
            time.sleep(0.05)
        helper_pid = int(companion_file.read_text().strip())
        helper_start = _get_proc_start_time(helper_pid)
        if helper_start:
            tracked_identities.add((helper_pid, helper_start))

        # Simulate unexpected assertion failure during setup
        raise RuntimeError("Simulated setup assertion failure")
    except RuntimeError as e:
        if str(e) == "Simulated setup assertion failure":
            failed_as_expected = True
    finally:
        _terminate_fixture_processes(
            tracked_identities=tracked_identities,
            fixture_dir=tmp_path,
            direct_children=[proc] if proc is not None else None,
        )
        surviving = _find_fixture_processes_for_dir(tmp_path)
        assert surviving == [], f"surviving fixture processes after setup failure: {surviving}"

    assert failed_as_expected is True


def test_find_fixture_processes_excludes_sibling_dirs_and_data_argv(
    tmp_path: Path
) -> None:
    """Verify _find_fixture_processes_for_dir:
    1. Excludes sibling directories (/tmp/.../case-sibling vs /tmp/.../case)
    2. Excludes python separated '-c' and attached '-cCODE' with fixture data argv
    3. Excludes python in stdin mode ('-') where fixture path is a data argument
    4. Excludes node in eval mode ('-e') and '--eval=CODE' where fixture path is a data argument
    5. Excludes external processes running with cwd inside fixture_dir
    6. Excludes imposter processes where argv[0] is named python/node but exe is external binary
    7. Includes python fixture script
    8. Includes node fixture script
    9. Includes native executable located inside fixture directory
    """
    case_dir = tmp_path / "case"
    sibling_dir = tmp_path / "case-sibling"
    case_dir.mkdir()
    sibling_dir.mkdir()
    data_file = case_dir / "data.txt"
    data_file.write_text("data\n", encoding="utf-8")

    sleep_bin = shutil.which("sleep") or "/bin/sleep"

    # Python fixture script
    script = case_dir / "worker.py"
    script.write_text("import time; time.sleep(60)\n", encoding="utf-8")

    # Node fixture script
    node_script = case_dir / "worker.mjs"
    node_script.write_text("setInterval(() => {}, 60000);\n", encoding="utf-8")

    # Native fixture executable: keep binary name 'sleep' so multi-call coreutils recognises it
    native_bin = case_dir / "sleep"
    shutil.copy(sleep_bin, native_bin)
    native_bin.chmod(0o755)

    # 1. cwd is sibling_dir
    p_sibling = subprocess.Popen(
        ["python3", "-c", "import time; time.sleep(60)"],
        cwd=str(sibling_dir),
    )
    # 2. Separated -c mode with data argv
    p_data = subprocess.Popen(
        ["python3", "-c", "import time; time.sleep(60)", str(case_dir)],
        cwd=str(tmp_path),
    )
    # 3. Attached -cCODE mode with data argv (FIX_05 reproduction case)
    p_attached_c = subprocess.Popen(
        [sys.executable, "-cimport time; time.sleep(60)", str(data_file)],
        cwd=str(tmp_path),
    )
    # 4. Python stdin mode '-' with data_file argument
    p_stdin = subprocess.Popen(
        [sys.executable, "-", str(data_file)],
        stdin=subprocess.PIPE,
        cwd=str(tmp_path),
    )
    # 5. Node inline eval mode '-e' with data_file argument
    p_node_eval = subprocess.Popen(
        ["node", "-e", "setInterval(() => {}, 60000)", str(data_file)],
        cwd=str(tmp_path),
    )
    # 6. Node attached '--eval=CODE' with data_file argument
    p_node_eval_eq = subprocess.Popen(
        ["node", "--eval=setInterval(() => {}, 60000)", str(data_file)],
        cwd=str(tmp_path),
    )
    # 7. External process running with cwd inside fixture_dir (cwd alone is not fixture identity)
    p_cwd_external = subprocess.Popen(
        [sleep_bin, "60"],
        cwd=str(case_dir),
    )
    # 8. Imposter process: argv[0] is 'python3' but exe is external binary (sleep)
    p_imposter = subprocess.Popen(
        ["python3", "60"],
        executable=sleep_bin,
        cwd=str(tmp_path),
    )
    # 9. Legitimate Python fixture script process
    p_case_py = subprocess.Popen(
        [sys.executable, str(script)],
        cwd=str(tmp_path),
    )
    # 10. Legitimate Node fixture script process
    p_case_node = subprocess.Popen(
        ["node", str(node_script)],
        cwd=str(tmp_path),
    )
    # 11. Legitimate native fixture executable
    p_case_native = subprocess.Popen(
        [str(native_bin), "60"],
        cwd=str(tmp_path),
    )

    all_procs = [
        p_sibling,
        p_data,
        p_attached_c,
        p_stdin,
        p_node_eval,
        p_node_eval_eq,
        p_cwd_external,
        p_imposter,
        p_case_py,
        p_case_node,
        p_case_native,
    ]

    try:
        found = _find_fixture_processes_for_dir(case_dir)
        found_pids = [pid for pid, _ in found]

        # Negative checks: must be strictly excluded
        assert p_sibling.pid not in found_pids, "sibling cwd process must not be matched"
        assert p_data.pid not in found_pids, "separated -c data argv process must not be matched"
        assert p_attached_c.pid not in found_pids, "attached -cCODE data argv process must not be matched"
        assert p_stdin.pid not in found_pids, "python stdin process with data arg must not be matched"
        assert p_node_eval.pid not in found_pids, "node separated -e with data arg must not be matched"
        assert p_node_eval_eq.pid not in found_pids, "node attached --eval= with data arg must not be matched"
        assert p_cwd_external.pid not in found_pids, "external process with fixture cwd must not be matched"
        assert p_imposter.pid not in found_pids, "imposter argv[0] process must not be matched"

        # Positive checks: must be matched
        assert p_case_py.pid in found_pids, "python fixture script process must be matched"
        assert p_case_node.pid in found_pids, "node fixture script process must be matched"
        assert p_case_native.pid in found_pids, "native fixture binary process must be matched"
    finally:
        for p in all_procs:
            try:
                if p.stdin:
                    p.stdin.close()
                p.terminate()
                p.wait(timeout=1.0)
            except Exception:
                p.kill()


def test_is_proc_running_inside_fixture_synthetic_proc(tmp_path: Path) -> None:
    """Verify _is_proc_running_inside_fixture against synthetic /proc entries:
    1. Rejects imposter argv[0] when exe is outside
    2. Rejects attached -cCODE, -m, -e, --eval=
    3. Rejects cwd inside fixture when exe is outside
    4. Accepts verified interpreter with regular script inside fixture
    5. Accepts native executable inside fixture
    """
    fixture_dir = tmp_path / "fixture"
    fixture_dir.mkdir()
    script = fixture_dir / "app.py"
    script.write_text("print('hi')", encoding="utf-8")
    data_file = fixture_dir / "data.json"
    data_file.write_text("{}", encoding="utf-8")
    native_exe = fixture_dir / "bin" / "daemon"
    native_exe.parent.mkdir()
    native_exe.write_text("#!/bin/sh\nexit 0\n", encoding="utf-8")
    native_exe.chmod(0o755)

    py_exe = os.path.realpath(sys.executable)
    node_bin = shutil.which("node")
    node_exe = os.path.realpath(node_bin) if node_bin else "/usr/bin/node"
    sleep_exe = os.path.realpath(shutil.which("sleep") or "/bin/sleep")

    proc_base = tmp_path / "synthetic_proc"
    proc_base.mkdir()

    def make_fake_proc(name: str, exe_target: str, cmdline: bytes, cwd_target: str | None = None) -> Path:
        p = proc_base / name
        p.mkdir()
        (p / "exe").symlink_to(exe_target)
        (p / "cmdline").write_bytes(cmdline)
        if cwd_target:
            (p / "cwd").symlink_to(cwd_target)
        return p

    # 1. Imposter argv[0] -> exe is sleep, cmdline says python3
    p_imposter = make_fake_proc("1", sleep_exe, b"python3\x00" + str(script).encode() + b"\x00")
    assert _is_proc_running_inside_fixture(p_imposter, fixture_dir) is False

    # 2. Attached -cCODE with data_file -> False
    p_att_c = make_fake_proc("2", py_exe, b"python3\x00-cimport time\x00" + str(data_file).encode() + b"\x00")
    assert _is_proc_running_inside_fixture(p_att_c, fixture_dir) is False

    # 3. Python module mode -m with data_file -> False
    p_mod = make_fake_proc("3", py_exe, b"python3\x00-mfoo\x00" + str(data_file).encode() + b"\x00")
    assert _is_proc_running_inside_fixture(p_mod, fixture_dir) is False

    # 4. Node attached --eval= with data_file -> False
    p_node_eval = make_fake_proc("4", node_exe, b"node\x00--eval=process.exit()\x00" + str(data_file).encode() + b"\x00")
    assert _is_proc_running_inside_fixture(p_node_eval, fixture_dir) is False

    # 5. External binary with cwd in fixture (cwd alone is not fixture identity) -> False
    p_cwd = make_fake_proc("5", sleep_exe, b"sleep\x0060\x00", cwd_target=str(fixture_dir))
    assert _is_proc_running_inside_fixture(p_cwd, fixture_dir) is False

    # 6. Legitimate Python script inside fixture -> True
    p_py_ok = make_fake_proc("6", py_exe, b"python3\x00" + str(script).encode() + b"\x00")
    assert _is_proc_running_inside_fixture(p_py_ok, fixture_dir) is True

    # 7. Legitimate Node script inside fixture -> True
    node_script = fixture_dir / "index.mjs"
    node_script.write_text("console.log('node');", encoding="utf-8")
    p_node_ok = make_fake_proc("7", node_exe, b"node\x00" + str(node_script).encode() + b"\x00")
    assert _is_proc_running_inside_fixture(p_node_ok, fixture_dir) is True

    # 8. Legitimate Native executable inside fixture -> True
    p_native_ok = make_fake_proc("8", str(native_exe), b"daemon\x00")
    assert _is_proc_running_inside_fixture(p_native_ok, fixture_dir) is True




def test_terminate_fixture_processes_skips_recycled_pid_with_mismatched_start_time() -> None:
    """Verify that _terminate_fixture_processes never signals a process if start_time doesn't match."""
    p = subprocess.Popen(["python3", "-c", "import time; time.sleep(60)"])
    real_start = _get_proc_start_time(p.pid)
    assert real_start is not None

    try:
        # Pass a mismatched start_time simulating a recycled PID
        recycled_identity = {(p.pid, "999999999")}
        _terminate_fixture_processes(recycled_identity, timeout=0.1)

        # Process p must still be alive and not signaled!
        assert p.poll() is None, "Process with mismatched start_time should not have been signaled"
    finally:
        p.terminate()
        p.wait()


def test_status_format_session_ready_and_auto_apply_ready_classification(
    repository_root: Path, tmp_path: Path
) -> None:
    """Verify Session ready vs Auto-apply ready separation across:
    1. Daily budget exhausted (paused_busy) + idle sessions: Session ready yes, Auto-apply ready paused
    2. Restart cooldown active:
       2-A. Idle sessions (isIdle: true) + future cooldown: Auto-apply ready yes (no server restart needed)
       2-B. Managed server running (isIdle: false) + future cooldown: Auto-apply ready waiting
    3. Auto-update disabled in options (valid) vs configuration options invalid (optionsValid: false)
    4. No staged candidate update
    5. Busy session blocker (CLI)
    """
    runtime_dir = tmp_path / "runtime"
    maint_dir = tmp_path / "maint"
    options_file = tmp_path / "options.json"
    runtime_dir.mkdir(parents=True)
    maint_dir.mkdir(parents=True)

    script = f"""
    process.env.CODEX_TEST_CLOCK = '2026-10-17T12:00:00.000Z';
    process.env.CODEX_RUNTIME_DIR = '{runtime_dir}';
    process.env.CODEX_MAINTENANCE_DIR = '{maint_dir}';
    process.env.CODEX_HA_OPTIONS_FILE = '{options_file}';
    const fs = await import('node:fs/promises');

    // Case 1: Daily budget exhausted (paused_busy), sessions idle, auto-update enabled
    await fs.writeFile('{options_file}', JSON.stringify({{ codex_auto_update: true }}));
    await mgr.updateState(s => {{
      s.stagedVersion = '0.163.0';
      s.candidateVersion = '0.163.0';
      s.status = 'paused_busy';
      s.reason = 'daily_budget_exhausted';
      s.idleCheckCount = 12;
      s.budgetDate = '2026-10-17';
      s.nextRetryAt = '2026-10-17T18:00:00.000Z';
    }});
    const status1 = await mgr.getStatus();
    const text1 = mgr.formatAutoApplyReady(status1);
    const sessionText1 = mgr.formatSessionReady(status1);

    // Case 2-A: Future restart cooldown + sessions completely idle (isIdle: true)
    // Cooldown is NOT a blocker because no running server needs graceful replacement
    await mgr.updateState(s => {{
      s.status = 'ready_to_apply';
      s.reason = null;
      s.idleCheckCount = 0;
      s.stagedVersion = '0.163.0';
      s.nextRestartAllowedAt = '2026-10-18T00:00:00.000Z';
    }});
    const status2a = await mgr.getStatus();
    const text2a = mgr.formatAutoApplyReady(status2a);

    // Case 2-B: Future restart cooldown + idle managed server running (isIdle: false)
    const status2b = {{
      ...status2a,
      isIdle: false,
      canApply: true,
      activeSessions: 1,
      processSummary: {{ cli: 0, managedIdleServers: 1, remoteStdio: 0, unmanagedAppServers: 0, unknown: 0, helpers: 0 }}
    }};
    const text2b = mgr.formatAutoApplyReady(status2b);

    // Case 3-A: Configuration options invalid (corrupted json)
    await fs.writeFile('{options_file}', '{{ corrupted json');
    const status3a = await mgr.getStatus();
    const text3a = mgr.formatAutoApplyReady(status3a);

    // Case 3-B: Auto-update explicitly disabled in valid options
    await fs.writeFile('{options_file}', JSON.stringify({{ codex_auto_update: false }}));
    const status3b = await mgr.getStatus();
    const text3b = mgr.formatAutoApplyReady(status3b);

    // Case 4: No staged candidate update
    await fs.writeFile('{options_file}', JSON.stringify({{ codex_auto_update: true }}));
    await mgr.updateState(s => {{
      s.stagedVersion = null;
      s.status = 'idle';
      s.reason = null;
      s.idleCheckCount = 0;
      s.nextRestartAllowedAt = null;
    }});
    const status4 = await mgr.getStatus();
    const text4 = mgr.formatAutoApplyReady(status4);

    // Case 5: Active session blocker present while update staged and budget available
    await mgr.updateState(s => {{
      s.stagedVersion = '0.163.0';
      s.candidateVersion = '0.163.0';
      s.status = 'ready_to_apply';
      s.reason = null;
      s.idleCheckCount = 1;
    }});
    const status5_raw = await mgr.getStatus();
    const status5 = {{
      ...status5_raw,
      canApply: false,
      isIdle: false,
      activeSessions: 1,
      processSummary: {{ cli: 1, managedIdleServers: 0, remoteStdio: 0, unmanagedAppServers: 0, unknown: 0, helpers: 0 }}
    }};
    const text5 = mgr.formatAutoApplyReady(status5);
    const sessionText5 = mgr.formatSessionReady(status5);

    console.log(JSON.stringify({{
      case1: {{
        canApply: status1.canApply,
        autoApplyReady: status1.autoApplyReady,
        sessionText: sessionText1,
        autoText: text1
      }},
      case2a: {{
        isIdle: status2a.isIdle,
        canApply: status2a.canApply,
        autoApplyReady: status2a.autoApplyReady,
        autoText: text2a
      }},
      case2b: {{
        isIdle: status2b.isIdle,
        canApply: status2b.canApply,
        autoText: text2b
      }},
      case3a: {{
        optionsValid: status3a.optionsValid,
        autoText: text3a
      }},
      case3b: {{
        optionsValid: status3b.optionsValid,
        autoApplyReady: status3b.autoApplyReady,
        autoText: text3b
      }},
      case4: {{
        canApply: status4.canApply,
        autoApplyReady: status4.autoApplyReady,
        autoText: text4
      }},
      case5: {{
        canApply: status5.canApply,
        sessionText: sessionText5,
        autoText: text5
      }}
    }}));
    """
    res = run_node_eval(script, repository_root)

    # Case 1: budget exhausted (paused_busy)
    c1 = res["case1"]
    assert c1["canApply"] is True
    assert c1["autoApplyReady"] is False
    assert "yes" in c1["sessionText"]
    assert "manual apply can run now" in c1["sessionText"]
    assert "paused (daily check budget exhausted" in c1["autoText"]
    assert "manual apply can re-check immediately" in c1["autoText"]

    # Case 2-A: future cooldown + isIdle true -> cooldown does NOT block apply
    c2a = res["case2a"]
    assert c2a["isIdle"] is True
    assert c2a["canApply"] is True
    assert c2a["autoApplyReady"] is True
    assert "yes (ready for next automatic apply check)" in c2a["autoText"]

    # Case 2-B: future cooldown + managed server running -> cooldown BLOCKS apply
    c2b = res["case2b"]
    assert c2b["isIdle"] is False
    assert c2b["canApply"] is True
    assert "waiting (restart cooldown active until" in c2b["autoText"]
    assert "manual apply also respects cooldown" in c2b["autoText"]

    # Case 3-A: options invalid -> blocked (configuration options invalid)
    c3a = res["case3a"]
    assert c3a["optionsValid"] is False
    assert "blocked (configuration options invalid)" in c3a["autoText"]

    # Case 3-B: auto-update disabled -> disabled (auto-update disabled; manual apply only)
    c3b = res["case3b"]
    assert c3b["optionsValid"] is True
    assert c3b["autoApplyReady"] is False
    assert "disabled (auto-update disabled; manual apply only)" in c3b["autoText"]

    # Case 4: no staged update
    c4 = res["case4"]
    assert c4["autoApplyReady"] is False
    assert "no (no staged update waiting to apply)" in c4["autoText"]

    # Case 5: busy blocker present
    c5 = res["case5"]
    assert c5["canApply"] is False
    assert "no (waiting for real sessions" in c5["sessionText"]
    assert "deferred (waiting for active sessions or unverifiable processes to clear)" in c5["autoText"]


def test_status_cli_text_output_includes_both_session_ready_and_auto_apply_ready(
    repository_root: Path, tmp_path: Path
) -> None:
    """Run actual CLI 'status' action and verify text banner and labels."""
    runtime_dir = tmp_path / "runtime"
    maint_dir = tmp_path / "maint"
    options_file = tmp_path / "options.json"
    runtime_dir.mkdir(parents=True)
    maint_dir.mkdir(parents=True)
    options_file.write_text(json.dumps({"codex_auto_update": True}), encoding="utf-8")

    # Set up state: budget exhausted
    state_file = runtime_dir / "state.json"
    state_file.write_text(json.dumps({
        "selectedVersion": "0.162.1",
        "stagedVersion": "0.163.0",
        "status": "paused_busy",
        "reason": "daily_budget_exhausted",
        "idleCheckCount": 12,
        "budgetDate": "2026-10-17",
        "nextRetryAt": "2026-10-17T18:00:00.000Z",
    }), encoding="utf-8")

    manager_script = repository_root / "codex_home_assistant" / "rootfs" / "usr" / "local" / "share" / "codex-ha" / "codex-runtime-manager.mjs"
    env = {
        **os.environ,
        "CODEX_RUNTIME_DIR": str(runtime_dir),
        "CODEX_MAINTENANCE_DIR": str(maint_dir),
        "CODEX_HA_OPTIONS_FILE": str(options_file),
    }
    proc = subprocess.run(
        ["node", str(manager_script), "status"],
        capture_output=True,
        text=True,
        env=env,
        check=True,
    )
    stdout = proc.stdout
    assert "Session ready:     yes (no Codex processes; manual apply can run now)" in stdout
    assert "Auto-apply ready:  paused (daily check budget exhausted; waiting for scheduled retry at 2026-10-17T18:00:00.000Z; manual apply can re-check immediately)" in stdout
    assert "Daily idle checks: 12/12 (date: 2026-10-17)" in stdout
    assert "Status:            paused_busy" in stdout


def test_active_network_io_cancellation_and_sigterm_exit(
    repository_root: Path, tmp_path: Path, request: pytest.FixtureRequest
) -> None:
    """Verify F2 requirements:
    1. fetchJson aborts immediately (< 500ms) on AbortSignal and does not hang on trickling streams
    2. fetchJson enforces wall-clock total timeout when no signal is given
    3. downloadAndStagePackage cleans up all partial archive/staging files upon abort
    4. codex-updater-daemon.mjs exits cleanly (returncode 0, < 1.5s) on SIGTERM during active network I/O
    """
    import socketserver
    import signal
    daemon_request_ready = threading.Event()

    class TrickleHandler(http.server.BaseHTTPRequestHandler):
        def do_GET(self):
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            if self.path == "/daemon":
                daemon_request_ready.set()
            try:
                for _ in range(100):
                    self.wfile.write(b" ")
                    self.wfile.flush()
                    time.sleep(0.05)
                self.wfile.write(b"{}")
                self.wfile.flush()
            except Exception:
                pass

        def log_message(self, format, *args):
            pass

    server = socketserver.ThreadingTCPServer(("127.0.0.1", 0), TrickleHandler)
    server.daemon_threads = True
    port = server.server_address[1]
    thread = threading.Thread(target=server.serve_forever)
    thread.daemon = True
    thread.start()
    def cleanup_server():
        server.shutdown()
        server.server_close()
        thread.join(timeout=2)
    request.addfinalizer(cleanup_server)

    manager_script = (
        repository_root
        / "codex_home_assistant"
        / "rootfs"
        / "usr"
        / "local"
        / "share"
        / "codex-ha"
        / "codex-runtime-manager.mjs"
    )
    daemon_script = (
        repository_root
        / "codex_home_assistant"
        / "rootfs"
        / "usr"
        / "local"
        / "share"
        / "codex-ha"
        / "codex-updater-daemon.mjs"
    )

    # 1. fetchJson abort on signal test
    script_abort = f"""
    import {{ fetchJson }} from '{manager_script}';
    const ac = new AbortController();
    const start = Date.now();
    setTimeout(() => ac.abort(), 150);
    try {{
      await fetchJson('http://127.0.0.1:{port}/trickle', {{ signal: ac.signal }});
      process.exit(1);
    }} catch (err) {{
      const elapsed = Date.now() - start;
      console.log(JSON.stringify({{ error: err.message, elapsed }}));
    }}
    """
    res_abort = subprocess.run(
        ["node", "--input-type=module", "-e", script_abort],
        capture_output=True,
        text=True,
        check=True,
    )
    data_abort = json.loads(res_abort.stdout)
    assert data_abort["error"] == "Operation aborted"
    assert data_abort["elapsed"] < 800

    # 2. fetchJson wall-clock total timeout test
    script_timeout = f"""
    import {{ fetchJson }} from '{manager_script}';
    const start = Date.now();
    try {{
      await fetchJson('http://127.0.0.1:{port}/trickle', {{ totalTimeoutMs: 350 }});
      process.exit(1);
    }} catch (err) {{
      const elapsed = Date.now() - start;
      console.log(JSON.stringify({{ error: err.message, elapsed }}));
    }}
    """
    res_timeout = subprocess.run(
        ["node", "--input-type=module", "-e", script_timeout],
        capture_output=True,
        text=True,
        check=True,
    )
    data_timeout = json.loads(res_timeout.stdout)
    assert "Total timeout" in data_timeout["error"]
    assert 300 <= data_timeout["elapsed"] <= 1200

    # 3. downloadAndStagePackage abort & staging cleanup test
    runtime_dir = tmp_path / "runtime"
    maint_dir = tmp_path / "maint"
    baseline_dir = tmp_path / "baseline"
    staging_dir = runtime_dir / "staging"
    runtime_dir.mkdir(parents=True)
    maint_dir.mkdir(parents=True)
    baseline_dir.mkdir(parents=True)

    script_dl_abort = f"""
    process.env.CODEX_RUNTIME_DIR = '{runtime_dir}';
    process.env.CODEX_MAINTENANCE_DIR = '{maint_dir}';
    import {{ downloadAndStagePackage }} from '{manager_script}';
    import fs from 'node:fs';

    const ac = new AbortController();
    const releaseInfo = {{
      version: '0.163.0',
      expectedSha256: '0000000000000000000000000000000000000000000000000000000000000000',
    }};
    setTimeout(() => ac.abort(), 150);
    const start = Date.now();
    try {{
      await downloadAndStagePackage(releaseInfo, 'http://127.0.0.1:{port}/pkg.tar.gz', {{ signal: ac.signal }});
      process.exit(1);
    }} catch (err) {{
      const elapsed = Date.now() - start;
      const files = fs.existsSync('{staging_dir}') ? fs.readdirSync('{staging_dir}') : [];
      console.log(JSON.stringify({{ error: err.message, elapsed, filesLeft: files }}));
    }}
    """
    res_dl = subprocess.run(
        ["node", "--input-type=module", "-e", script_dl_abort],
        capture_output=True,
        text=True,
        check=True,
    )
    data_dl = json.loads(res_dl.stdout)
    assert data_dl["error"] == "Operation aborted"
    assert data_dl["elapsed"] < 800
    assert data_dl["filesLeft"] == []

    # 4. codex-updater-daemon.mjs SIGTERM exit during active trickle
    options_file = tmp_path / "options.json"
    options_file.write_text(json.dumps({"codex_auto_update": True, "codex_auto_update_timezone": "UTC"}), encoding="utf-8")
    (baseline_dir / "codex-package.json").write_text(
        json.dumps({"version": "0.162.1", "target": "x86_64-unknown-linux-musl", "entrypoint": "bin/codex"}),
        encoding="utf-8",
    )
    (baseline_dir / "bin").mkdir()
    (baseline_dir / "bin" / "codex").write_text("#!/bin/sh\nexit 0\n")
    (baseline_dir / "bin" / "codex").chmod(0o755)

    env = {
        **os.environ,
        "CODEX_HA_OPTIONS_FILE": str(options_file),
        "CODEX_RUNTIME_DIR": str(runtime_dir),
        "CODEX_BASELINE_DIR": str(baseline_dir),
        "CODEX_MAINTENANCE_DIR": str(maint_dir),
    }
    # Override transport only in this owned test process; the production
    # daemon retains the fixed official release endpoint.
    bootstrap = (
        "import https from 'node:https'; import http from 'node:http';"
        "import {syncBuiltinESMExports} from 'node:module';"
        f"https.get=(_url,opts,cb)=>http.get('http://127.0.0.1:{port}/daemon',opts,cb);"
        "syncBuiltinESMExports();"
        f"await import({json.dumps(daemon_script.as_uri())});"
    )
    p = subprocess.Popen(
        ["node", "--input-type=module", "-e", bootstrap],
        env=env,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    )
    def cleanup_daemon():
        if p.poll() is None:
            p.terminate()
            try:
                p.wait(timeout=2)
            except subprocess.TimeoutExpired:
                p.kill()
                p.wait(timeout=2)
        p.stdout.close()
        p.stderr.close()
    request.addfinalizer(cleanup_daemon)
    assert daemon_request_ready.wait(5), "daemon never reached the active request"
    t_term_start = time.perf_counter()
    p.send_signal(signal.SIGTERM)
    stdout, stderr = p.communicate(timeout=5)
    term_elapsed = time.perf_counter() - t_term_start
    assert p.returncode == 0
    assert term_elapsed < 1.5
    assert "updater_stopped" in stdout
    assert "Operation aborted" in stdout


def test_redirect_cleanup_deadline_and_late_archive_open(repository_root: Path, tmp_path: Path):
    """Every redirect shares one budget; abort must also cover pending file opens."""
    import socketserver

    class Handler(http.server.BaseHTTPRequestHandler):
        def log_message(self, *args):
            pass

        def do_GET(self):
            if self.path == "/redirect":
                self.send_response(302)
                self.send_header("Location", "/json")
                self.end_headers()
                try:
                    for _ in range(100):
                        self.wfile.write(b" ")
                        self.wfile.flush()
                        time.sleep(0.02)
                except (BrokenPipeError, ConnectionResetError):
                    pass
            elif self.path.startswith("/chain/"):
                hop = int(self.path.rsplit("/", 1)[1])
                time.sleep(0.08)
                self.send_response(302 if hop < 5 else 200)
                if hop < 5:
                    self.send_header("Location", f"/chain/{hop + 1}")
                self.send_header("Content-Length", "0")
                self.end_headers()
            else:
                self.send_response(200)
                self.send_header("Content-Length", "2")
                self.end_headers()
                self.wfile.write(b"{}")

    class Server(socketserver.ThreadingTCPServer):
        daemon_threads = True

    server = Server(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    manager = repository_root / "codex_home_assistant/rootfs/usr/local/share/codex-ha/codex-runtime-manager.mjs"
    url = f"http://127.0.0.1:{server.server_address[1]}"
    try:
        script = f"""
        import {{ fetchJson }} from {json.dumps(manager.as_uri())};
        const ac = new AbortController();
        await fetchJson('{url}/redirect', {{ signal: ac.signal, totalTimeoutMs: 300 }});
        ac.abort();
        let sharedDeadline = false;
        try {{ await fetchJson('{url}/chain/0', {{ totalTimeoutMs: 180 }}); }}
        catch (e) {{ sharedDeadline = e.message.includes('Total timeout'); }}
        console.log(JSON.stringify({{ sharedDeadline }}));
        """
        proc = subprocess.run(["node", "--input-type=module", "-e", script],
                              capture_output=True, text=True, timeout=4, check=True)
        assert json.loads(proc.stdout)["sharedDeadline"] is True

        runtime = tmp_path / "runtime"
        script_open = f"""
        import fs from 'node:fs/promises';
        import {{syncBuiltinESMExports}} from 'node:module';
        const originalOpen = fs.open;
        fs.open = async function(p, ...args) {{
          if (String(p).includes('.download-')) await new Promise(r => setTimeout(r, 200));
          return originalOpen.call(this, p, ...args);
        }};
        syncBuiltinESMExports();
        process.env.CODEX_RUNTIME_DIR = {json.dumps(str(runtime))};
        const {{downloadAndStagePackage}} = await import({json.dumps(manager.as_uri())});
        const ac = new AbortController();
        setTimeout(() => ac.abort(), 50);
        let aborted = false;
        try {{ await downloadAndStagePackage({{version:'0.163.0',expectedSha256:'0'.repeat(64)}},
                                              '{url}/json', {{signal:ac.signal}}); }}
        catch(e) {{ aborted = e.message === 'Operation aborted'; }}
        await new Promise(r => setTimeout(r, 250));
        console.log(JSON.stringify({{aborted,files:await fs.readdir({json.dumps(str(runtime / 'staging'))})}}));
        """
        proc = subprocess.run(["node", "--input-type=module", "-e", script_open],
                              capture_output=True, text=True, timeout=4, check=True)
        result = json.loads(proc.stdout)
        assert result == {"aborted": True, "files": []}
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=2)
