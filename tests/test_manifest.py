import hashlib
import re
from pathlib import Path


MANIFEST_ENTRY = re.compile(r"^- `([0-9a-f]{64})`  `([^`]+)`$", re.MULTILINE)


def test_document_manifest_matches_lf_normalized_files(
    repository_root: Path,
) -> None:
    attributes = (repository_root / ".gitattributes").read_text(encoding="utf-8")
    assert "*.md text eol=lf" in attributes.splitlines()

    manifest = (repository_root / "MANIFEST.md").read_text(encoding="utf-8")
    entries = MANIFEST_ENTRY.findall(manifest)
    assert len(entries) == 14

    names = [name for _, name in entries]
    assert len(names) == len(set(names))
    for expected, name in entries:
        relative_path = Path(name)
        assert not relative_path.is_absolute()
        assert ".." not in relative_path.parts
        content = (repository_root / relative_path).read_bytes()
        normalized = content.replace(b"\r\n", b"\n")
        assert hashlib.sha256(normalized).hexdigest() == expected, name
