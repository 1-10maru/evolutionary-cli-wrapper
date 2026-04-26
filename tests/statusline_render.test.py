"""Integration tests for statusline.py rendering paths.

Covers the three rendering states described in src/statusline.py:
  1. proxy-fresh   — recent (<10 s old) .evo-live.json present  → bold render
                     with grade label.
  2. proxy-stale   — 10–60 s old .evo-live.json present        → dim render
                     with the "(待機中)" marker.
  3. fallback      — no proxy state at all                     → self-track
                     tip rotation. Asserts that rotating across many sessions
                     surfaces ≥ 16 distinct tips.

Run with:
    python -m pytest tests/statusline_render.test.py -v

This test only depends on Python stdlib + a checked-in statusline.py at the
repo root. It never writes outside the per-test isolated tmp dir.
"""

from __future__ import annotations

import json
import os
import re
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parent.parent
STATUSLINE = REPO_ROOT / "statusline.py"


# ANSI control-sequence stripper (covers SGR \x1b[...m and CSI \x1b[...).
_ANSI_RE = re.compile(r"\x1b\[[0-9;]*[A-Za-z]")


def strip_ansi(s: str) -> str:
    return _ANSI_RE.sub("", s)


def run_statusline(stdin_obj: dict, fake_home: Path, cwd_dir: Path) -> str:
    """Spawn statusline.py with isolated HOME/USERPROFILE and capture stdout."""
    env = {**os.environ}
    # Strip Windows HOMEDRIVE/HOMEPATH because Python's os.path.expanduser('~')
    # on Windows checks USERPROFILE first, but if USERPROFILE is unset it
    # falls back to HOMEDRIVE+HOMEPATH. We override the canonical paths so
    # ~/.claude/... lands inside fake_home.
    env["USERPROFILE"] = str(fake_home)
    env["HOME"] = str(fake_home)
    env.pop("HOMEDRIVE", None)
    env.pop("HOMEPATH", None)
    proc = subprocess.run(
        [sys.executable, str(STATUSLINE)],
        input=json.dumps(stdin_obj),
        capture_output=True,
        text=True,
        env=env,
        cwd=str(cwd_dir),
        encoding="utf-8",
    )
    if proc.returncode != 0:
        raise AssertionError(
            f"statusline.py exited {proc.returncode}\n"
            f"stderr:\n{proc.stderr}\nstdout:\n{proc.stdout}"
        )
    return proc.stdout


def write_live_state(cwd_dir: Path, age_ms: float, **fields) -> None:
    """Write <cwd>/.evo/live-state.json with the given age (ms in the past)."""
    evo_dir = cwd_dir / ".evo"
    evo_dir.mkdir(parents=True, exist_ok=True)
    payload = {
        "avatar": "🦊",
        "nickname": "TestPet",
        "turns": 5,
        "userMessages": 5,
        "bond": 50,
        "idealStateGauge": 70,
        "comboCount": 0,
        "sessionGrade": "A",
        "promptScore": 75,
        "signalKind": "good_structure",
        "advice": "test advice",
        "adviceDetail": "",
        "beforeExample": "",
        "afterExample": "",
        "updatedAt": int((time.time() * 1000) - age_ms),
    }
    payload.update(fields)
    (evo_dir / "live-state.json").write_text(
        json.dumps(payload), encoding="utf-8"
    )


class TestStatuslineRender(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory(prefix="evo-statusline-")
        self.tmp_root = Path(self._tmp.name)
        self.fake_home = self.tmp_root / "home"
        self.fake_home.mkdir(parents=True, exist_ok=True)
        # Pre-create ~/.claude so the self-state writer has somewhere to land.
        (self.fake_home / ".claude").mkdir(parents=True, exist_ok=True)
        self.cwd_dir = self.tmp_root / "project"
        self.cwd_dir.mkdir(parents=True, exist_ok=True)

    def tearDown(self) -> None:
        self._tmp.cleanup()

    # ------------------------------------------------------------------
    # Path 1: proxy-fresh
    # ------------------------------------------------------------------
    def test_proxy_fresh_renders_grade_and_no_stale_marker(self) -> None:
        write_live_state(self.cwd_dir, age_ms=2_000)  # 2 s old → fresh
        stdin = {
            "model": {"display_name": "claude-opus-4-7"},
            "cwd": str(self.cwd_dir),
            "context_window": {"used_percentage": 25},
            "rate_limits": {},
        }
        out = run_statusline(stdin, self.fake_home, self.cwd_dir)
        plain = strip_ansi(out)
        # The fresh render uses "TestPet" (from our seed) and includes the
        # grade label "A 上手" emitted by _grade_label('A').
        self.assertIn("TestPet", plain)
        self.assertIn("A", plain)  # grade A label substring
        # No stale marker.
        self.assertNotIn("(待機中)", plain)

    # ------------------------------------------------------------------
    # Path 2: proxy-stale
    # ------------------------------------------------------------------
    def test_proxy_stale_renders_with_machi_marker(self) -> None:
        # 30 s old → falls in the [10s, 60s) stale window.
        write_live_state(self.cwd_dir, age_ms=30_000)
        stdin = {
            "model": {"display_name": "claude-opus-4-7"},
            "cwd": str(self.cwd_dir),
            "context_window": {"used_percentage": 25},
            "rate_limits": {},
        }
        out = run_statusline(stdin, self.fake_home, self.cwd_dir)
        plain = strip_ansi(out)
        self.assertIn("(待機中)", plain)
        # The "TestPet" name still appears in the dimmed line.
        self.assertIn("TestPet", plain)

    # ------------------------------------------------------------------
    # Path 3: self-track fallback (no .evo-live.json anywhere)
    # ------------------------------------------------------------------
    def test_fallback_renders_tip_and_call_count(self) -> None:
        # No live-state seeded anywhere → fallback path.
        stdin = {
            "model": {"display_name": "claude-opus-4-7"},
            "cwd": str(self.cwd_dir),
            "context_window": {"used_percentage": 5},
            "rate_limits": {},
        }
        out = run_statusline(stdin, self.fake_home, self.cwd_dir)
        plain = strip_ansi(out)
        # Fallback emits the call-count badge ("1回目").
        self.assertRegex(plain, r"\d+回目")
        # And a tip line (light-bulb 💡).
        self.assertIn("💡", out)

    def test_fallback_rotates_through_at_least_16_unique_tips(self) -> None:
        # Bump the call counter past 16 by re-running with a stable cwd /
        # ctx_pct so no session reset fires. The self-state file is shared
        # across runs because we hold fake_home stable.
        seen_lines: set[str] = set()
        stdin = {
            "model": {"display_name": "claude-opus-4-7"},
            "cwd": str(self.cwd_dir),
            "context_window": {"used_percentage": 5},
            "rate_limits": {},
        }
        for _ in range(40):
            out = run_statusline(stdin, self.fake_home, self.cwd_dir)
            plain = strip_ansi(out)
            # Pull just the tip headline (the line starting with 💡).
            for line in plain.split("\n"):
                if "💡" in line:
                    seen_lines.add(line.strip())
                    break
        # Self-track fallback must rotate through ≥ 16 distinct tips.
        self.assertGreaterEqual(
            len(seen_lines),
            16,
            f"only saw {len(seen_lines)} unique tip lines after 40 calls",
        )


if __name__ == "__main__":
    unittest.main()
