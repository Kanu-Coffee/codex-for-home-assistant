import hashlib
import http.server
import io
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

    script = f"""
    process.env.CODEX_RUNTIME_DIR = '{runtime_dir}';
    process.env.CODEX_MAINTENANCE_DIR = '{maint_dir}';
    process.env.SUPERVISOR_TOKEN = 'secret-token-should-not-leak';
    await mgr.initRuntime();
    const status = await mgr.getStatus();
    console.log(JSON.stringify(status));
    """
    status = run_node_eval(script, repository_root)
    assert status["appVersion"] == "0.7.1-dev.6"
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
    assert "-m|--model|-c|--config|-C|--cd|--profile|--color|-s|--sandbox)" in wrapper_content
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
          -m|--model|-c|--config|-C|--cd|--profile|--color|-s|--sandbox)
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
    """
    proc = subprocess.run(["bash", "-c", bash_test], capture_output=True, text=True, check=True)
    lines = proc.stdout.strip().split("\n")
    assert lines[0] == "1:subcommand=false;count=0"
    assert lines[1] == "2:subcommand=true;count=1"
    assert lines[2] == "3:subcommand=false;count=0"
    assert lines[3] == "4:subcommand=false;count=0"
    assert lines[4] == "5:subcommand=true;count=2"


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

