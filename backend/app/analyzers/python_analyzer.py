import json
import subprocess
from pathlib import Path
from typing import Any


def run_ruff_and_bandit(project_dir: str) -> list[dict[str, Any]]:
    findings: list[dict[str, Any]] = []
    root = Path(project_dir)

    ruff_proc = subprocess.run(
        ["ruff", "check", "--output-format", "json", str(root)],
        capture_output=True,
        text=True,
        timeout=30,
    )
    if ruff_proc.stdout:
        for item in json.loads(ruff_proc.stdout):
            findings.append(
                {
                    "tool": "ruff",
                    "code": item.get("code"),
                    "message": item.get("message"),
                    "filename": item.get("filename"),
                    "line": item.get("location", {}).get("row", 1),
                }
            )

    bandit_proc = subprocess.run(
        ["bandit", "-r", "-f", "json", str(root)],
        capture_output=True,
        text=True,
        timeout=30,
    )
    if bandit_proc.stdout:
        data = json.loads(bandit_proc.stdout)
        for item in data.get("results", []):
            findings.append(
                {
                    "tool": "bandit",
                    "code": item.get("test_id"),
                    "message": item.get("issue_text"),
                    "filename": item.get("filename"),
                    "line": item.get("line_number", 1),
                    "severity": item.get("issue_severity", "MEDIUM"),
                }
            )
    return findings
