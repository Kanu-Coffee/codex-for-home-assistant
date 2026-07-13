import re
from pathlib import Path


TEXT_SUFFIXES = {
    "",
    ".conf",
    ".json",
    ".jsonc",
    ".md",
    ".py",
    ".sh",
    ".toml",
    ".txt",
    ".yaml",
    ".yml",
}
IGNORED_PARTS = {".git", ".pytest_cache", "__pycache__"}


def repository_text_files(repository_root: Path):
    for path in repository_root.rglob("*"):
        if not path.is_file() or any(part in IGNORED_PARTS for part in path.parts):
            continue
        if path.suffix.lower() in TEXT_SUFFIXES or path.name == "Dockerfile":
            yield path


def test_no_runtime_secret_files_are_present(repository_root: Path) -> None:
    forbidden_names = {"auth.json", "authorized_keys", "secrets.yaml"}
    forbidden_files = [
        str(path.relative_to(repository_root))
        for path in repository_root.rglob("*")
        if path.is_file()
        and path.name in forbidden_names
        and ".git" not in path.parts
    ]
    private_host_keys = [
        str(path.relative_to(repository_root))
        for path in repository_root.rglob("ssh_host_*_key")
        if path.is_file() and ".git" not in path.parts
    ]

    assert forbidden_files == []
    assert private_host_keys == []


def test_no_common_secret_patterns_are_committed(repository_root: Path) -> None:
    private_key_marker = "-----BEGIN " + r"(?:OPENSSH|RSA|EC) PRIVATE KEY-----"
    patterns = {
        "private key": re.compile(private_key_marker),
        "OpenAI API key": re.compile(r"\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b"),
        "GitHub token": re.compile(r"\bgh[pousr]_[A-Za-z0-9]{30,}\b"),
        "JWT access token": re.compile(
            r"\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b"
        ),
    }
    findings: list[str] = []

    for path in repository_text_files(repository_root):
        try:
            content = path.read_text(encoding="utf-8")
        except UnicodeDecodeError:
            continue
        for label, pattern in patterns.items():
            if pattern.search(content):
                findings.append(f"{path.relative_to(repository_root)}: {label}")

    assert findings == []
