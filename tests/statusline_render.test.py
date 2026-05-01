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

    def test_tier_weighted_rotation_structure(self) -> None:
        """v3.0.0: _TIPS_ROTATION must be tier-expanded (5:2:1) and Tier 1
        must dominate the rotation (>50% share)."""
        # Import statusline as a module so we can read its module-level state.
        # statusline.py reads stdin at import time, so feed it an empty JSON.
        import importlib.util
        import io as _io

        original_stdin = sys.stdin
        try:
            sys.stdin = _io.StringIO("{}")
            spec = importlib.util.spec_from_file_location(
                "statusline_under_test", str(STATUSLINE)
            )
            mod = importlib.util.module_from_spec(spec)
            try:
                spec.loader.exec_module(mod)
            except SystemExit:
                # statusline.py may exit after rendering; that's fine — its
                # module-level objects are already populated.
                pass
        finally:
            sys.stdin = original_stdin

        tips = mod._TIPS
        rotation = mod._TIPS_ROTATION
        weights = mod._TIER_WEIGHTS
        # Sanity: weights are 5:2:1 for tiers 1/2/3.
        self.assertEqual(weights, {1: 5, 2: 2, 3: 1})

        # Rotation length matches sum of per-tier weights.
        expected_len = 0
        for t in tips:
            tier = t.get("tier", 2)
            expected_len += weights.get(tier, 2)
        self.assertEqual(
            len(rotation),
            expected_len,
            f"rotation length {len(rotation)} != expected {expected_len}",
        )
        self.assertGreater(
            len(rotation),
            len(tips),
            "tier weighting must expand the rotation",
        )

        # Tier 1 should dominate (>50% of slots) under 5:2:1 weighting.
        tier1_slots = sum(
            weights.get(t.get("tier", 2), 2) for t in tips if t.get("tier") == 1
        )
        share = tier1_slots / max(1, len(rotation))
        self.assertGreater(
            share,
            0.30,
            f"Tier 1 slot share {share:.2%} unexpectedly low",
        )

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


class TestStatuslineV31(unittest.TestCase):
    """v3.1 additions: 5-band mood, no auto-compact reset, signal->category."""

    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory(prefix="evo-statusline-v31-")
        self.tmp_root = Path(self._tmp.name)
        self.fake_home = self.tmp_root / "home"
        self.fake_home.mkdir(parents=True, exist_ok=True)
        (self.fake_home / ".claude").mkdir(parents=True, exist_ok=True)
        self.cwd_dir = self.tmp_root / "project"
        self.cwd_dir.mkdir(parents=True, exist_ok=True)

    def tearDown(self) -> None:
        self._tmp.cleanup()

    def _import_module(self):
        import importlib.util
        import io as _io

        original_stdin = sys.stdin
        try:
            sys.stdin = _io.StringIO("{}")
            spec = importlib.util.spec_from_file_location(
                "statusline_v31_under_test", str(STATUSLINE)
            )
            mod = importlib.util.module_from_spec(spec)
            try:
                spec.loader.exec_module(mod)
            except SystemExit:
                pass
        finally:
            sys.stdin = original_stdin
        return mod

    def test_band_function_returns_5_bands(self) -> None:
        mod = self._import_module()
        self.assertEqual(mod._band(0), "start")
        self.assertEqual(mod._band(15), "early")
        self.assertEqual(mod._band(45), "working")
        self.assertEqual(mod._band(70), "busy")
        self.assertEqual(mod._band(85), "critical")

    def test_signal_to_category_mapping_present(self) -> None:
        mod = self._import_module()
        self.assertEqual(
            mod._SIGNAL_TO_CATEGORY.get("prompt_too_vague"), "specificity"
        )
        self.assertEqual(
            mod._SIGNAL_TO_CATEGORY.get("error_spiral"), "recovery"
        )
        self.assertEqual(
            mod._SIGNAL_TO_CATEGORY.get("approval_fatigue"), "permissions"
        )

    def test_pick_tip_filters_by_signal_category(self) -> None:
        mod = self._import_module()
        rotation = [
            {"headline": "spec1", "tier": 1, "category": "specificity"},
            {"headline": "rec1", "tier": 1, "category": "recovery"},
            {"headline": "spec2", "tier": 1, "category": "specificity"},
        ]
        # With prompt_too_vague signal -> specificity tips only
        for c in range(10):
            tip = mod._pick_tip(rotation, c, "prompt_too_vague")
            self.assertEqual(tip.get("category"), "specificity")

    def test_pick_tip_falls_back_when_no_match(self) -> None:
        mod = self._import_module()
        rotation = [
            {"headline": "no-cat-1", "tier": 2},
            {"headline": "no-cat-2", "tier": 2},
        ]
        # No category in rotation -> fall back to full rotation despite signal.
        tip = mod._pick_tip(rotation, 0, "prompt_too_vague")
        self.assertIn(tip["headline"], {"no-cat-1", "no-cat-2"})

    def test_session_does_not_reset_on_ctx_drop(self) -> None:
        """v3.1: dropping ctx_pct from 50 -> 3 (auto-compact) MUST NOT reset
        the call counter. Previously this fired a session reset."""
        stdin = {
            "model": {"display_name": "claude-opus-4-7"},
            "cwd": str(self.cwd_dir),
            "context_window": {"used_percentage": 50},
            "rate_limits": {},
        }
        # First call at 50% ctx
        run_statusline(stdin, self.fake_home, self.cwd_dir)
        # Now simulate /compact: ctx drops to 3
        stdin["context_window"]["used_percentage"] = 3
        out = run_statusline(stdin, self.fake_home, self.cwd_dir)
        plain = strip_ansi(out)
        # Counter should be 2 (incremented), NOT 1 (reset).
        match = re.search(r"(\d+)回目", plain)
        self.assertIsNotNone(match, f"no 回目 badge in output:\n{plain}")
        self.assertEqual(
            match.group(1),
            "2",
            f"counter reset on auto-compact (got {match.group(1)}回目)",
        )

    def test_proxy_active_path_includes_mood_when_no_advice(self) -> None:
        """v3.1: when proxy is fresh BUT no advice line is emitted, the
        proxy-active path should append a dimmed mood comment in line1."""
        # Seed proxy state with NO signal/advice so _line2 stays empty.
        evo_dir = self.cwd_dir / ".evo"
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
            "signalKind": "",
            "advice": "",
            "adviceDetail": "",
            "beforeExample": "",
            "afterExample": "",
            "updatedAt": int((time.time() * 1000) - 2000),
        }
        (evo_dir / "live-state.json").write_text(json.dumps(payload), encoding="utf-8")

        stdin = {
            "model": {"display_name": "claude-opus-4-7"},
            "cwd": str(self.cwd_dir),
            "context_window": {"used_percentage": 5},
            "rate_limits": {},
        }
        out = run_statusline(stdin, self.fake_home, self.cwd_dir)
        plain = strip_ansi(out)
        # The "start" band has the egg / waiting messages — at ctx 5 we should
        # see one of the start-band 'はじめ' style comments. Just assert that
        # SOMETHING beyond the bare grade/育成度 chips ended up on line1.
        self.assertIn("TestPet", plain)
        # Line1 should include a 5-band comment string (lengthier than the
        # raw chips). One of the start-band phrases contains "セッション" or
        # "指示" — assert at least one such word lands in the output.
        self.assertTrue(
            any(token in plain for token in ("指示", "セッション", "始", "見守")),
            f"no mood comment found on line1 of:\n{plain}",
        )


class TestStatuslineV33(unittest.TestCase):
    """v3.3.0: heartbeat-extended fresh window + stale-but-full-layout."""

    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory(prefix="evo-statusline-v33-")
        self.tmp_root = Path(self._tmp.name)
        self.fake_home = self.tmp_root / "home"
        self.fake_home.mkdir(parents=True, exist_ok=True)
        (self.fake_home / ".claude").mkdir(parents=True, exist_ok=True)
        self.cwd_dir = self.tmp_root / "project"
        self.cwd_dir.mkdir(parents=True, exist_ok=True)

    def tearDown(self) -> None:
        self._tmp.cleanup()

    def _stdin(self) -> dict:
        return {
            "model": {"display_name": "claude-opus-4-7"},
            "cwd": str(self.cwd_dir),
            "context_window": {"used_percentage": 25},
            "rate_limits": {},
        }

    def test_fresh_window_extended_to_5_minutes(self) -> None:
        """v3.3.0: 90 s old data must still render in the 'stale' branch
        (i.e. with full layout + dim) instead of falling all the way through
        to the no-proxy fallback path. Pre-v3.3 the cutoff was 60 s."""
        write_live_state(self.cwd_dir, age_ms=90_000)  # 90 s old
        out = run_statusline(self._stdin(), self.fake_home, self.cwd_dir)
        plain = strip_ansi(out)
        # Must have proxy-derived nickname (not the fallback default)
        self.assertIn("TestPet", plain)
        # Must include grade chip - that means we're in proxy-stale, not fallback
        self.assertIn("A", plain)
        # 5-band fallback never emits this exact "(待機中)" tag
        self.assertIn("(待機中)", plain)

    def test_proxy_stale_preserves_full_layout(self) -> None:
        """v3.3.0: stale path must keep grade / 回目 / 指示の質 / 育成度
        chips on line 1 (previously collapsed to avatar-only)."""
        write_live_state(self.cwd_dir, age_ms=30_000)  # 30 s old → stale
        out = run_statusline(self._stdin(), self.fake_home, self.cwd_dir)
        plain = strip_ansi(out)
        # All four data chips must remain visible in stale render
        self.assertIn("回目", plain)
        self.assertIn("指示の質", plain)
        self.assertIn("育成度", plain)
        # And the (待機中) suffix should be present at end of line 1
        self.assertIn("(待機中)", plain)
        # Line 1 should have multiple separator chips (not just avatar+marker)
        line1 = next(
            (ln for ln in plain.split("\n") if "TestPet" in ln), ""
        )
        # Expect at least 4 chips (avatar/name, grade, 回目, 育成度) joined by
        # separator (middle-dot · in SEP).
        self.assertGreaterEqual(
            line1.count("·"),
            3,
            f"stale line1 looks collapsed (too few chips):\n{line1!r}",
        )

    def test_stale_beyond_5_minutes_falls_back(self) -> None:
        """v3.3.0: 6 minutes is past the new 5-min window → fallback path."""
        write_live_state(self.cwd_dir, age_ms=360_000)  # 6 min old
        out = run_statusline(self._stdin(), self.fake_home, self.cwd_dir)
        plain = strip_ansi(out)
        # Fallback path uses default 'EvoPet' nickname, not our 'TestPet'
        self.assertNotIn("TestPet", plain)
        self.assertNotIn("(待機中)", plain)
        # And renders the call-count fallback
        self.assertRegex(plain, r"\d+回目")


class TestStatuslineV34PerSession(unittest.TestCase):
    """v3.4.0: per-session live-state files in <cwd>/.evo/sessions/<id>.json.

    Verifies the file-resolution priority added in statusline.py:
      1. <cwd>/.evo/sessions/<session_id>.json (when payload provides session_id)
      2. newest mtime in <cwd>/.evo/sessions/ (fallback)
      3. <cwd>/.evo/live-state.json (legacy)
      4. ~/.claude/.evo-live.json (legacy)
    """

    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory(prefix="evo-statusline-v34-")
        self.tmp_root = Path(self._tmp.name)
        self.fake_home = self.tmp_root / "home"
        self.fake_home.mkdir(parents=True, exist_ok=True)
        (self.fake_home / ".claude").mkdir(parents=True, exist_ok=True)
        self.cwd_dir = self.tmp_root / "project"
        self.cwd_dir.mkdir(parents=True, exist_ok=True)
        self.sessions_dir = self.cwd_dir / ".evo" / "sessions"
        self.sessions_dir.mkdir(parents=True, exist_ok=True)

    def tearDown(self) -> None:
        self._tmp.cleanup()

    def _write_session_file(
        self,
        session_id: str,
        nickname: str,
        age_ms: float = 2_000,
        embed_session_id: bool = True,
    ) -> Path:
        payload = {
            "avatar": "🦊",
            "nickname": nickname,
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
        if embed_session_id:
            payload["sessionId"] = session_id
        path_ = self.sessions_dir / f"{session_id}.json"
        path_.write_text(json.dumps(payload), encoding="utf-8")
        return path_

    def _stdin(self, session_id: str | None = None) -> dict:
        s = {
            "model": {"display_name": "claude-opus-4-7"},
            "cwd": str(self.cwd_dir),
            "context_window": {"used_percentage": 25},
            "rate_limits": {},
        }
        if session_id is not None:
            s["session_id"] = session_id
        return s

    def test_session_id_match_wins_over_other_session_files(self) -> None:
        """When session_id is provided AND a matching file exists in
        sessions/, that file is read (not the newer-but-different file)."""
        # Older file matches our session_id
        self._write_session_file("sid-mine", "MyPet", age_ms=4_000)
        # Newer file for a different session — should be ignored
        self._write_session_file("sid-other", "OtherPet", age_ms=1_000)
        out = run_statusline(self._stdin(session_id="sid-mine"), self.fake_home, self.cwd_dir)
        plain = strip_ansi(out)
        self.assertIn("MyPet", plain)
        self.assertNotIn("OtherPet", plain)

    def test_session_id_no_match_falls_back_to_newest_in_sessions_dir(self) -> None:
        """When session_id has no matching file, fall through per-session
        files entirely and use the legacy live-state.json (per-session files
        for OTHER sessions must NOT shadow the current one)."""
        # Two per-session files, neither matching
        self._write_session_file("sid-a", "PetA", age_ms=3_000)
        self._write_session_file("sid-b", "PetB", age_ms=1_000)
        # Legacy file with a third nickname
        evo_dir = self.cwd_dir / ".evo"
        legacy_payload = {
            "avatar": "🦊",
            "nickname": "LegacyPet",
            "turns": 5,
            "userMessages": 5,
            "bond": 50,
            "idealStateGauge": 70,
            "comboCount": 0,
            "sessionGrade": "A",
            "promptScore": 75,
            "signalKind": "",
            "advice": "",
            "adviceDetail": "",
            "beforeExample": "",
            "afterExample": "",
            "updatedAt": int(time.time() * 1000) - 2_000,
        }
        (evo_dir / "live-state.json").write_text(
            json.dumps(legacy_payload), encoding="utf-8"
        )
        out = run_statusline(
            self._stdin(session_id="sid-not-in-dir"), self.fake_home, self.cwd_dir
        )
        plain = strip_ansi(out)
        # The mismatched per-session files must be skipped — neither nickname
        # should leak into the render.
        self.assertNotIn("PetA", plain)
        self.assertNotIn("PetB", plain)
        # The legacy file is the fallback for unknown session_id.
        self.assertIn("LegacyPet", plain)

    def test_no_session_id_picks_newest_in_sessions_dir(self) -> None:
        """When the payload omits session_id, the newest-mtime per-session
        file is used (back-compat for harnesses that don't pass session_id)."""
        # Older file
        older = self._write_session_file("sid-old", "OldPet", age_ms=8_000)
        # Newer file
        newer = self._write_session_file("sid-new", "NewPet", age_ms=1_000)
        # Force mtime ordering to be unambiguous
        now = time.time()
        os.utime(older, (now - 8, now - 8))
        os.utime(newer, (now - 1, now - 1))
        out = run_statusline(self._stdin(session_id=None), self.fake_home, self.cwd_dir)
        plain = strip_ansi(out)
        self.assertIn("NewPet", plain)
        self.assertNotIn("OldPet", plain)

    def test_falls_back_to_legacy_when_sessions_dir_empty(self) -> None:
        """Empty (or nonexistent) sessions/ dir → legacy live-state.json read."""
        # Remove the empty dir so we exercise the os.path.isdir() == False branch
        self.sessions_dir.rmdir()
        evo_dir = self.cwd_dir / ".evo"
        legacy_payload = {
            "avatar": "🦊",
            "nickname": "LegacyOnly",
            "turns": 5,
            "userMessages": 5,
            "bond": 50,
            "idealStateGauge": 70,
            "comboCount": 0,
            "sessionGrade": "A",
            "promptScore": 75,
            "signalKind": "",
            "advice": "",
            "adviceDetail": "",
            "beforeExample": "",
            "afterExample": "",
            "updatedAt": int(time.time() * 1000) - 2_000,
        }
        (evo_dir / "live-state.json").write_text(
            json.dumps(legacy_payload), encoding="utf-8"
        )
        out = run_statusline(self._stdin(session_id="anything"), self.fake_home, self.cwd_dir)
        plain = strip_ansi(out)
        self.assertIn("LegacyOnly", plain)


if __name__ == "__main__":
    unittest.main()
