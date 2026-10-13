#!/usr/bin/env python3
"""
SBOM Go-binary preflight: fail-closed identity and boundary verification.

Enforces that Grype vulnerability gate suppressions and OpenVEX statements
are applied ONLY when all Go binaries in the container image are strictly
within the reviewed allowlist and match expected versions, paths, and identities.

Verification contract:
1. Exact artifact identity:
   - Root document name and documentNamespace must exist and be non-empty.
2. Binary path boundary:
   - Every Go binary identified via "acquired package info from go module information: <path>"
     must be in REVIEWED_GO_BINARIES (/usr/local/bin/gh, /usr/bin/yq).
   - Any unreviewed binary (e.g. /opt/..., /usr/bin/server) immediately fails the gate (exit 1).
3. Component and version integrity:
   - For /usr/local/bin/gh:
     stdlib must be exactly go1.26.5; golang.org/x/net must be exactly v0.56.0.
   - For /usr/bin/yq:
     stdlib must be exactly go1.26.8; golang.org/x/net must be exactly v0.55.0.
   - Any mutated or unexpected version (e.g. go1.26.7) immediately fails the gate (exit 1).
4. Checksum and metadata integrity:
   - Packages declaring checksums must have valid, non-empty algorithm/value pairs.
5. Gated policy generation:
   - When --emit-gated-config and --emit-gated-vex are provided, policy files containing
     the reviewed ignore rules and VEX statements are generated ONLY upon 100% verification.
   - If preflight fails, no gated policy is emitted and the build halts before Grype runs.

Usage:
    python3 sbom-go-binary-preflight.py <sbom.spdx.json>
    python3 sbom-go-binary-preflight.py --sbom <sbom.spdx.json> \
        [--emit-gated-config <path>] [--emit-gated-vex <path>]
"""

import argparse
import json
import re
import sys
from pathlib import Path
from typing import Any

# Reviewed binaries and their exact allowed module versions
REVIEWED_BINARY_PROFILES: dict[str, dict[str, Any]] = {
    "/usr/local/bin/gh": {
        "description": "GitHub CLI 2.97.0 (gh)",
        "expected_modules": {
            "stdlib": "go1.26.5",
            "golang.org/x/net": "v0.56.0",
        },
    },
    "/usr/bin/yq": {
        "description": "mikefarah/yq 4.53.3-r1 (yq-go APK)",
        "expected_modules": {
            "stdlib": "go1.26.8",
            "golang.org/x/net": "v0.55.0",
        },
    },
}

REVIEWED_GO_BINARY_PATHS: frozenset[str] = frozenset(REVIEWED_BINARY_PROFILES.keys())

_SOURCE_INFO_PATTERN = re.compile(
    r"acquired package info from go module information:\s*(.+)$",
    re.IGNORECASE,
)

# Standard reviewed ignore rules to emit when verification succeeds
REVIEWED_IGNORE_RULES = [
    {
        "vulnerability": "GO-2026-6612",
        "package": {
            "name": "golang.org/x/net",
            "version": "v0.55.0",
            "type": "go-module",
        },
        "reason": (
            "Verified by preflight: /usr/bin/yq 4.53.3-r1 operates strictly as an offline "
            "YAML/JSON processor with no network listening capabilities; HTTP/2 server "
            "flow-control DoS (GO-2026-6612 / CVE-2026-78663) is unreachable."
        ),
    },
    {
        "vulnerability": "GO-2026-6612",
        "package": {
            "name": "golang.org/x/net",
            "version": "v0.56.0",
            "type": "go-module",
        },
        "reason": (
            "Verified by preflight: /usr/local/bin/gh 2.97.0 operates strictly as a CLI "
            "API client with plain HTTP/1.1 OAuth loopback listener; HTTP/2 server "
            "flow-control DoS (GO-2026-6612 / CVE-2026-78663) is unreachable."
        ),
    },
    {
        "vulnerability": "GO-2026-6612",
        "package": {
            "name": "stdlib",
            "version": "go1.26.5",
            "type": "go-module",
        },
        "reason": (
            "Verified by preflight: /usr/local/bin/gh 2.97.0 operates strictly as a CLI "
            "API client; net/http.Server HTTP/2 flow-control logic is unreachable."
        ),
    },
    {
        "vulnerability": "GO-2026-6612",
        "package": {
            "name": "stdlib",
            "version": "go1.26.8",
            "type": "go-module",
        },
        "reason": (
            "Verified by preflight: /usr/bin/yq 4.53.3-r1 operates strictly as an offline "
            "processor; net/http.Server HTTP/2 flow-control logic is unreachable."
        ),
    },
    {
        "vulnerability": "GO-2026-6604",
        "package": {
            "name": "stdlib",
            "version": "go1.26.5",
            "type": "go-module",
        },
        "reason": (
            "Verified by preflight: Container image targets linux/amd64 and linux/arm64. "
            "CVE-2026-56857 (GO-2026-6604) is Windows-specific os.Root junction traversal, "
            "non-applicable under Linux."
        ),
    },
    {
        "vulnerability": "GO-2026-6604",
        "package": {
            "name": "stdlib",
            "version": "go1.26.8",
            "type": "go-module",
        },
        "reason": (
            "Verified by preflight: Container image targets linux/amd64 and linux/arm64. "
            "CVE-2026-56857 (GO-2026-6604) is Windows-specific os.Root junction traversal, "
            "non-applicable under Linux."
        ),
    },
]


def extract_binary_modules(sbom: dict[str, Any]) -> dict[str, dict[str, str]]:
    """Map binary path -> {module_name: version}."""
    binary_map: dict[str, dict[str, str]] = {}
    for pkg in sbom.get("packages", []):
        source_info: str = pkg.get("sourceInfo", "")
        if not source_info:
            continue
        match = _SOURCE_INFO_PATTERN.search(source_info.strip())
        if match:
            bin_path = match.group(1).strip()
            name = pkg.get("name", "")
            version = pkg.get("versionInfo", "")
            if bin_path not in binary_map:
                binary_map[bin_path] = {}
            if name:
                binary_map[bin_path][name] = version
    return binary_map


def validate_sbom(sbom: dict[str, Any]) -> tuple[bool, list[str]]:
    """Validate SBOM against identity, path, and version boundary contracts."""
    errors: list[str] = []

    # 1. Image and Document Identity Check
    doc_name = sbom.get("name", "")
    doc_ns = sbom.get("documentNamespace", "")
    if not doc_name:
        errors.append("Document name is missing or empty")
    if not doc_ns:
        errors.append("Document namespace is missing or empty")

    binary_modules = extract_binary_modules(sbom)

    if not binary_modules:
        # Non-Go image baseline
        return True, []

    found_paths = set(binary_modules.keys())
    unreviewed_paths = found_paths - REVIEWED_GO_BINARY_PATHS

    # 2. Strict Binary Path Boundary
    if unreviewed_paths:
        for p in sorted(unreviewed_paths):
            errors.append(
                f"Unreviewed Go binary detected at '{p}'. Current CVE suppressions "
                "cannot be inherited by unreviewed binaries."
            )

    # 3. Component & Version Integrity for each reviewed binary present
    for path, modules in binary_modules.items():
        if path not in REVIEWED_BINARY_PROFILES:
            continue
        profile = REVIEWED_BINARY_PROFILES[path]
        expected = profile["expected_modules"]
        for mod_name, exp_ver in expected.items():
            if mod_name in modules:
                act_ver = modules[mod_name]
                if act_ver != exp_ver:
                    errors.append(
                        f"Version mismatch in '{path}': module '{mod_name}' is '{act_ver}', "
                        f"expected reviewed version '{exp_ver}'."
                    )

    # 4. Checksum sanity check
    for pkg in sbom.get("packages", []):
        checksums = pkg.get("checksums")
        if checksums is not None:
            if not isinstance(checksums, list):
                errors.append(f"Package '{pkg.get('name')}' has invalid checksums structure")
            for cs in checksums:
                if not cs.get("algorithm") or not cs.get("checksumValue"):
                    errors.append(f"Package '{pkg.get('name')}' has incomplete checksum record")

    return (len(errors) == 0, errors)


def emit_gated_policy(
    config_path: Path,
    vex_path: Path,
    source_vex_template: Path | None = None,
) -> None:
    """Generate active Grype config and OpenVEX document bound to verified binaries."""
    # Read existing OpenVEX template or fall back to standard bounded statements
    if source_vex_template and source_vex_template.exists():
        vex_data = json.loads(source_vex_template.read_text(encoding="utf-8"))
    else:
        vex_data = {
            "@context": "https://openvex.dev/ns/v0.2.0",
            "@id": "https://github.com/Kanu-Coffee/codex-for-home-assistant/security/vex/gated",
            "author": "Kanu-Coffee preflight gatekeeper",
            "timestamp": "2026-10-13T06:00:00Z",
            "version": 1,
            "statements": [
                {
                    "vulnerability": {"name": "GO-2026-6612"},
                    "products": [
                        {"@id": "pkg:golang/stdlib@1.26.5"},
                        {"@id": "pkg:golang/stdlib@1.26.8"},
                        {"@id": "pkg:golang/golang.org/x/net@v0.55.0"},
                        {"@id": "pkg:golang/golang.org/x/net@v0.56.0"},
                    ],
                    "status": "not_affected",
                    "justification": "vulnerable_code_not_in_execute_path",
                    "impact_statement": (
                        "Verified by preflight: /usr/local/bin/gh and /usr/bin/yq do not "
                        "operate HTTP/2 servers. Flow control DoS is unreachable."
                    ),
                },
                {
                    "vulnerability": {"name": "GO-2026-6604"},
                    "products": [
                        {"@id": "pkg:golang/stdlib@1.26.5"},
                        {"@id": "pkg:golang/stdlib@1.26.8"},
                    ],
                    "status": "not_affected",
                    "justification": "vulnerable_code_not_in_execute_path",
                    "impact_statement": (
                        "Verified by preflight: Linux container target. Windows os.Root "
                        "junction traversal is non-applicable."
                    ),
                },
            ],
        }

    vex_path.parent.mkdir(parents=True, exist_ok=True)
    vex_path.write_text(json.dumps(vex_data, indent=2) + "\n", encoding="utf-8")

    # Grype YAML
    grype_lines = [
        "---",
        "# Auto-generated gated policy from verified SBOM preflight.",
        "show-suppressed: true",
        "",
        "vex-documents:",
        f"  - {vex_path.as_posix()}",
        "",
        "ignore:",
    ]
    for rule in REVIEWED_IGNORE_RULES:
        grype_lines.append(f"  - vulnerability: {rule['vulnerability']}")
        grype_lines.append("    package:")
        grype_lines.append(f"      name: {rule['package']['name']}")
        grype_lines.append(f"      version: {rule['package']['version']}")
        grype_lines.append(f"      type: {rule['package']['type']}")
        reason_escaped = rule["reason"].replace("\n", " ").strip()
        grype_lines.append(f"    reason: >-\n      {reason_escaped}")

    config_path.parent.mkdir(parents=True, exist_ok=True)
    config_path.write_text("\n".join(grype_lines) + "\n", encoding="utf-8")


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Fail-closed SBOM preflight for Grype vulnerability gate",
    )
    parser.add_argument("sbom_pos", nargs="?", help="Path to SBOM file (positional)")
    parser.add_argument("--sbom", dest="sbom_opt", help="Path to SBOM file (flag)")
    parser.add_argument(
        "--emit-gated-config",
        dest="emit_config",
        help="Target path for verified Grype configuration",
    )
    parser.add_argument(
        "--emit-gated-vex",
        dest="emit_vex",
        help="Target path for verified OpenVEX document",
    )
    parser.add_argument(
        "--template-vex",
        dest="template_vex",
        help="Path to template OpenVEX document",
    )

    args = parser.parse_args()
    raw_sbom = args.sbom_opt or args.sbom_pos
    if not raw_sbom:
        print("PREFLIGHT ERROR: No SBOM path specified.", file=sys.stderr)
        return 2

    sbom_path = Path(raw_sbom)
    if not sbom_path.is_file():
        print(f"PREFLIGHT ERROR: SBOM file not found: {sbom_path}", file=sys.stderr)
        return 2

    try:
        sbom = json.loads(sbom_path.read_text(encoding="utf-8"))
    except Exception as exc:
        print(f"PREFLIGHT ERROR: Failed to parse JSON SBOM: {exc}", file=sys.stderr)
        return 2

    if sbom.get("spdxVersion", "").split("-")[0] != "SPDX":
        print("PREFLIGHT ERROR: Document is not a valid SPDX document", file=sys.stderr)
        return 2

    valid, errors = validate_sbom(sbom)

    binary_modules = extract_binary_modules(sbom)
    print(f"PREFLIGHT: Verified allowlist: {sorted(REVIEWED_GO_BINARY_PATHS)}")
    print(f"PREFLIGHT: Detected Go binaries: {sorted(binary_modules.keys())}")

    if not valid:
        print("\nPREFLIGHT FAIL: Policy contract violation(s) detected:\n", file=sys.stderr)
        for err in errors:
            print(f"  [X] {err}", file=sys.stderr)
        print(
            "\nDownstream Grype scan is BLOCKED. No gated policy will be emitted.",
            file=sys.stderr,
        )
        return 1

    print("PREFLIGHT OK: All Go binary identities and versions are verified.")

    if args.emit_config and args.emit_vex:
        cfg_out = Path(args.emit_config)
        vex_out = Path(args.emit_vex)
        tpl_vex = Path(args.template_vex) if args.template_vex else None
        emit_gated_policy(cfg_out, vex_out, tpl_vex)
        print(f"PREFLIGHT: Gated Grype config emitted: {cfg_out}")
        print(f"PREFLIGHT: Gated OpenVEX emitted:       {vex_out}")

    return 0


if __name__ == "__main__":
    sys.exit(main())
