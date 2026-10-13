#!/usr/bin/env python3
"""
Generate minimal synthetic SPDX JSON SBOM fixtures for preflight and Grype tests.

Fixtures:
  sbom-reviewed-only.spdx.json    — Only reviewed binaries (/usr/local/bin/gh, /usr/bin/yq)
  sbom-unreviewed-binary.spdx.json — Reviewed + /opt/some-server (same stdlib version)
  sbom-mutated-version.spdx.json  — Reviewed binaries but stdlib go1.26.7 (unreviewed version)
  sbom-no-go.spdx.json            — No Go modules at all (non-Go image baseline)

Run from repository root:
    python3 tests/fixtures/sbom_vuln_gate/generate_fixtures.py
"""

import json
import uuid
from pathlib import Path

OUT = Path(__file__).parent


def spdx_doc(name: str, packages: list[dict]) -> dict:
    return {
        "spdxVersion": "SPDX-2.3",
        "dataLicense": "CC0-1.0",
        "SPDXID": "SPDXRef-DOCUMENT",
        "name": name,
        "documentNamespace": f"https://anchore.com/syft/image/{name}-{uuid.uuid4()}",
        "creationInfo": {
            "licenseListVersion": "3.28",
            "creators": ["Organization: Anchore, Inc", "Tool: syft-1.42.3"],
            "created": "2026-10-13T04:41:21Z",
        },
        "packages": packages,
    }


def go_module_pkg(
    name: str,
    version: str,
    spdx_id_suffix: str,
    binary_path: str,
    purl: str,
    checksum: str = "aabbccdd" * 8,
) -> dict:
    return {
        "name": name,
        "SPDXID": f"SPDXRef-Package-go-module-{spdx_id_suffix}",
        "versionInfo": version,
        "supplier": "NOASSERTION",
        "downloadLocation": "NOASSERTION",
        "filesAnalyzed": False,
        "checksums": [{"algorithm": "SHA256", "checksumValue": checksum}],
        "sourceInfo": f"acquired package info from go module information: {binary_path}",
        "licenseConcluded": "NOASSERTION",
        "licenseDeclared": "BSD-3-Clause",
        "copyrightText": "NOASSERTION",
        "externalRefs": [
            {
                "referenceCategory": "SECURITY",
                "referenceType": "cpe23Type",
                "referenceLocator": f"cpe:2.3:a:{name}:{name}:{version}:*:*:*:*:*:*:*",
            },
            {
                "referenceCategory": "PACKAGE-MANAGER",
                "referenceType": "purl",
                "referenceLocator": purl,
            },
        ],
    }


# ── Packages for reviewed binaries ───────────────────────────────────────────

GH_STDLIB = go_module_pkg(
    "stdlib",
    "go1.26.5",
    "stdlib-gh-1a2b3c",
    "/usr/local/bin/gh",
    "pkg:golang/stdlib@1.26.5",
    "aaaa" * 16,
)
GH_XNET = go_module_pkg(
    "golang.org/x/net",
    "v0.56.0",
    "xnet-gh-4d5e6f",
    "/usr/local/bin/gh",
    "pkg:golang/golang.org/x/net@v0.56.0",
    "bbbb" * 16,
)
YQ_STDLIB = go_module_pkg(
    "stdlib",
    "go1.26.8",
    "stdlib-yq-7a8b9c",
    "/usr/bin/yq",
    "pkg:golang/stdlib@1.26.8",
    "cccc" * 16,
)
YQ_XNET = go_module_pkg(
    "golang.org/x/net",
    "v0.55.0",
    "xnet-yq-1d2e3f",
    "/usr/bin/yq",
    "pkg:golang/golang.org/x/net@v0.55.0",
    "dddd" * 16,
)

# ── Package for unreviewed binary (same versions, different path) ─────────────

UNREVIEWED_STDLIB = go_module_pkg(
    "stdlib",
    "go1.26.5",
    "stdlib-server-ff00aa",
    "/opt/some-server",
    "pkg:golang/stdlib@1.26.5",
    "eeee" * 16,
)
UNREVIEWED_XNET = go_module_pkg(
    "golang.org/x/net",
    "v0.56.0",
    "xnet-server-ff00bb",
    "/opt/some-server",
    "pkg:golang/golang.org/x/net@v0.56.0",
    "ffff" * 16,
)

# ── Package for mutated stdlib version ───────────────────────────────────────

MUTATED_STDLIB = go_module_pkg(
    "stdlib",
    "go1.26.7",
    "stdlib-gh-mutated-11223344",
    "/usr/local/bin/gh",
    "pkg:golang/stdlib@1.26.7",
    "1111" * 16,
)


def write(filename: str, doc: dict) -> None:
    out = OUT / filename
    out.write_text(json.dumps(doc, indent=2) + "\n", encoding="utf-8")
    print(f"  Written: {out}")


def main() -> None:
    print("Generating SBOM fixtures...")

    # Fixture 1: only reviewed binaries — preflight OK, Grype should pass with policy
    write(
        "sbom-reviewed-only.spdx.json",
        spdx_doc(
            "test-image-reviewed-only",
            [GH_STDLIB, GH_XNET, YQ_STDLIB, YQ_XNET],
        ),
    )

    # Fixture 2: reviewed + unreviewed binary — preflight MUST fail
    write(
        "sbom-unreviewed-binary.spdx.json",
        spdx_doc(
            "test-image-unreviewed-binary",
            [GH_STDLIB, GH_XNET, YQ_STDLIB, YQ_XNET, UNREVIEWED_STDLIB, UNREVIEWED_XNET],
        ),
    )

    # Fixture 3: mutated stdlib version go1.26.7 — preflight OK (path is reviewed)
    # but Grype would fail because go1.26.7 is not in ignore rules
    write(
        "sbom-mutated-version.spdx.json",
        spdx_doc(
            "test-image-mutated-version",
            [MUTATED_STDLIB, GH_XNET, YQ_STDLIB, YQ_XNET],
        ),
    )

    # Fixture 4: no Go modules — non-Go image baseline, preflight OK
    write(
        "sbom-no-go.spdx.json",
        spdx_doc(
            "test-image-no-go",
            [
                {
                    "name": "python3",
                    "SPDXID": "SPDXRef-Package-python3",
                    "versionInfo": "3.12.0",
                    "supplier": "NOASSERTION",
                    "downloadLocation": "NOASSERTION",
                    "filesAnalyzed": False,
                    "licenseConcluded": "NOASSERTION",
                    "licenseDeclared": "PSF-2.0",
                    "copyrightText": "NOASSERTION",
                }
            ],
        ),
    )

    print("Done.")


if __name__ == "__main__":
    main()
