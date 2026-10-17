#!/usr/bin/env python3
"""Issue scan exceptions only after verifying reviewed bytes in the actual image.

The caller supplies Docker's identity for the exact image Syft scanned. SPDX
file hashes are compared with the reviewed, architecture-specific manifest;
Go module checksums are never mistaken for executable hashes. The root scanner config grants no exceptions. Unknown/missing metadata causes no exception.
"""
import argparse
import hashlib
import subprocess
import tempfile
import copy
import json
import re
import sys
from pathlib import Path, PurePosixPath
from urllib.parse import parse_qs, unquote, urlsplit

SECURITY_DIR = Path(__file__).resolve().parents[1] / 'security'
PROFILES = {
    '/usr/local/bin/gh': {'stdlib': 'go1.26.5', 'golang.org/x/net': 'v0.56.0'},
    '/usr/bin/yq': {'stdlib': 'go1.26.9', 'golang.org/x/net': 'v0.55.0'},
}
SOURCE = re.compile(r'acquired package info from go module information:\s*(/[^\n]+)$')
SHA256 = re.compile(r'^[0-9a-f]{64}$')


class NotReviewed(ValueError):
    """Valid inventory, but no reviewed exception applies; use the raw scan."""



def purls(package):
    return [r.get('referenceLocator', '') for r in package.get('externalRefs', [])
            if r.get('referenceType') == 'purl']


def checksum(record):
    values = [c.get('checksumValue') for c in record.get('checksums', [])
              if c.get('algorithm') == 'SHA256']
    if len(values) != 1 or not isinstance(values[0], str) or not SHA256.fullmatch(values[0]):
        raise ValueError('Missing or ambiguous SHA256')
    return values[0]


def validate_sbom(sbom, identity=None):
    if not isinstance(sbom, dict) or sbom.get('spdxVersion') != 'SPDX-2.3':
        raise ValueError('Expected SPDX-2.3 object')
    if not sbom.get('name') or not sbom.get('documentNamespace'):
        raise ValueError('Document name/namespace missing')
    packages = sbom.get('packages')
    if not isinstance(packages, list):
        raise ValueError('Package inventory missing')
    modules = {}
    for pkg in packages:
        refs = purls(pkg)
        source = pkg.get('sourceInfo', '')
        # Detect Go independently of the optional Syft sourceInfo description.
        is_go = (any(p.startswith('pkg:golang/') for p in refs) or 'go module information' in source
                 or pkg.get('name') in {'stdlib', 'golang.org/x/net'})
        if not is_go:
            continue
        match = SOURCE.fullmatch(source.strip())
        if not match:
            raise ValueError('Go package has missing/unknown binary mapping')
        path = match.group(1)
        if path not in PROFILES:
            raise NotReviewed('Unreviewed Go binary: ' + path)
        name, version = pkg.get('name'), pkg.get('versionInfo')
        if not name or not version:
            raise ValueError('Go module name/version missing')
        if name in modules.setdefault(path, {}):
            raise ValueError('Duplicate/ambiguous Go module mapping')
        modules[path][name] = version
    if not modules:
        if identity and identity.get('binaries'):
            raise ValueError('Actual Go binaries are absent from SBOM inventory')
        # A genuine non-Go inventory needs no vulnerability exception.
        return None
    for path, found in modules.items():
        for name, version in PROFILES[path].items():
            if name not in found:
                raise ValueError('Required module missing: ' + path + ' ' + name)
            if found[name] != version:
                raise NotReviewed('Module version has no reviewed exception: ' + path + ' ' + name)
    if not identity or identity.get('os') != 'linux' or identity.get('architecture') not in ['amd64', 'arm64']:
        raise ValueError('Actual Linux image identity/architecture missing or unsupported')
    if set(identity.get('binaries', {})) != set(modules):
        raise ValueError('Actual Go binary inventory and SBOM differ')
    image_id = identity.get('id', '')
    if not image_id.startswith('sha256:') or not SHA256.fullmatch(image_id[7:]):
        raise ValueError('Actual image ID missing')
    roots = [r.get('relatedSpdxElement') for r in sbom.get('relationships', [])
             if r.get('spdxElementId') == sbom.get('SPDXID') and r.get('relationshipType') == 'DESCRIBES']
    described = [p for p in packages if p.get('SPDXID') in roots]
    if len(roots) != 1 or len(described) != 1:
        raise ValueError('Image subject missing or ambiguous')
    root = described[0]
    if (root.get('name') != identity.get('name') or sbom['name'] != identity.get('name')
            or root.get('versionInfo') != identity.get('version')):
        raise ValueError('SBOM is not bound to the actual scan image')
    subjects = [p for p in purls(root) if p.startswith('pkg:oci/')]
    if len(subjects) != 1:
        raise ValueError('OCI subject missing or ambiguous')
    subject = subjects[0]
    parsed = urlsplit(subject)
    if (unquote(parsed.path.rsplit('@', 1)[-1]) != 'sha256:' + checksum(root)
            or parse_qs(parsed.query).get('arch') != [identity['architecture']]):
        raise ValueError('OCI image digest/architecture mismatch')
    reviewed = json.loads((SECURITY_DIR / 'reviewed-go-binaries.json').read_text())['architectures'][identity['architecture']]
    files = {}
    for file in sbom.get('files', []):
        raw = file.get('fileName', '')
        if '..' in PurePosixPath(raw).parts:
            raise ValueError('Unsafe inventory file path')
        path = '/' + raw.removeprefix('./').lstrip('/')
        if path in modules:
            if path in files:
                raise ValueError('Duplicate binary file identity')
            files[path] = checksum(file)
    for path in modules:
        actual = identity.get('binaries', {}).get(path)
        if not actual or files.get(path) != actual:
            raise ValueError('SBOM file SHA256 is missing or differs from actual image: ' + path)
        if actual != reviewed[path]:
            raise NotReviewed('Binary bytes have no reviewed exception: ' + path)
    return {'subject': subject, 'paths': sorted(modules), 'image_id': image_id}


def emit_policy(config_path, vex_path, verified, template_path, sbom_hash):
    template = json.loads(template_path.read_text())
    vex = copy.deepcopy(template)
    if verified is None:
        vex['statements'] = []
    else:
        for statement in vex['statements']:
            statement['products'] = [{'@id': verified['subject'], 'subcomponents': statement['products']}]
    # Audit evidence, deliberately not consumed by the scanner. SPDX adapters
    # can lose image tags/digests needed to enforce a scoped VEX product.
    vex['sbom_sha256'] = sbom_hash
    vex['verified_image_id'] = verified['image_id'] if verified else None
    vex_path.parent.mkdir(parents=True, exist_ok=True)
    vex_path.write_text(json.dumps(vex, indent=2) + '\n')
    rules = []
    if verified:
        for path in verified['paths']:
            for module, version in PROFILES[path].items():
                # The exact reviewed Alpine r2 yq uses patched Go 1.26.9.
                # Validate its stdlib identity above, but issue no stdlib waiver.
                if path == '/usr/bin/yq' and module == 'stdlib':
                    continue
                vulns = ['GO-2026-6612'] + (['GO-2026-6604'] if module == 'stdlib' else [])
                if module == 'stdlib':
                    # NVD/CPE and Go/PURL catalogers report the same reviewed
                    # issues under separate IDs in real SPDX.
                    vulns.extend(['CVE-2026-78663', 'CVE-2026-56857'])
                for vuln in vulns:
                    rules.append({'vulnerability': vuln, 'package': {'name': module,
                                  'version': version, 'type': 'go-module'},
                                  'reason': 'Reviewed Linux CLI bytes: ' + path + '; SBOM SHA256 ' + sbom_hash})
    # JSON is valid YAML; keeping generation dependency-free avoids another tool.
    config_path.parent.mkdir(parents=True, exist_ok=True)
    config_path.write_text(json.dumps({'show-suppressed': True, 'ignore': rules}, indent=2) + '\n')


def inspect_image(image, version):
    """Read immutable Docker image bytes without executing either architecture."""
    info = json.loads(subprocess.check_output(['docker', 'image', 'inspect', image], text=True))[0]
    identity = {'id': info['Id'], 'name': image.rsplit(':', 1)[0], 'version': version,
                'os': info['Os'], 'architecture': info['Architecture'], 'binaries': {}}
    container = subprocess.check_output(['docker', 'create', '--entrypoint', '/bin/true', info['Id']], text=True).strip()
    try:
        with tempfile.TemporaryDirectory(prefix='codex-go-identity-') as directory:
            for path in PROFILES:
                dest = Path(directory) / Path(path).name
                subprocess.run(['docker', 'cp', container + ':' + path, str(dest)], check=True,
                               stdout=subprocess.DEVNULL)
                if not dest.is_file() or dest.is_symlink():
                    raise ValueError('Expected regular binary file: ' + path)
                with dest.open('rb') as binary:
                    identity['binaries'][path] = hashlib.file_digest(binary, 'sha256').hexdigest()
    finally:
        subprocess.run(['docker', 'rm', '-f', '-v', container], check=True, stdout=subprocess.DEVNULL)
    return identity


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('sbom_pos', nargs='?')
    parser.add_argument('--sbom')
    parser.add_argument('--image-identity', type=Path)
    parser.add_argument('--image')
    parser.add_argument('--version')
    parser.add_argument('--architecture', choices=['amd64', 'arm64', 'aarch64'])
    parser.add_argument('--emit-gated-config', type=Path)
    parser.add_argument('--emit-gated-vex', type=Path)
    parser.add_argument('--template-vex', type=Path, default=SECURITY_DIR / 'openvex.json')
    args = parser.parse_args()
    # Never leave a previous successful exception behind after a failed check.
    snapshot = args.emit_gated_config.with_suffix('.sbom.json') if args.emit_gated_config else None
    for out in [args.emit_gated_config, args.emit_gated_vex, snapshot]:
        if out:
            out.unlink(missing_ok=True)
    try:
        source = args.sbom or args.sbom_pos
        if not source:
            raise ValueError('SBOM path missing')
        raw_sbom = Path(source).read_bytes()
        sbom = json.loads(raw_sbom)
        identity = (inspect_image(args.image, args.version) if args.image else
                    json.loads(args.image_identity.read_text()) if args.image_identity else None)
        expected_arch = {'aarch64': 'arm64'}.get(args.architecture, args.architecture)
        if expected_arch and (not identity or identity.get('architecture') != expected_arch):
            raise ValueError('Build matrix architecture mismatch')
        subject = validate_sbom(sbom, identity)
        if bool(args.emit_gated_config) != bool(args.emit_gated_vex):
            raise ValueError('Both policy output paths are required')
        if args.emit_gated_config:
            emit_policy(args.emit_gated_config, args.emit_gated_vex, subject, args.template_vex,
                        hashlib.sha256(raw_sbom).hexdigest())
            snapshot.write_bytes(raw_sbom)
    except NotReviewed as error:
        print('PREFLIGHT: No exception issued; use raw scan: ' + str(error), file=sys.stderr)
        return 3
    except (ValueError, TypeError, KeyError, AttributeError, OSError, subprocess.SubprocessError) as error:
        print('PREFLIGHT FAIL: ' + str(error), file=sys.stderr)
        return 1
    print('PREFLIGHT OK: ' + ('no Go exceptions' if subject is None else 'reviewed binary bytes; target-bound scan policy'))
    return 0


if __name__ == '__main__':
    sys.exit(main())
