#!/usr/bin/env python3
"""
Per-run observation collector for Udu lineage experiments.

Usage:
  ./scripts/observe.py [--until-gen N] [--port 4246]

Tails the udu-backend container's logs, captures every cortex decision and
death event, snapshots rules at each death, and emits a summary when the
target generation count is reached.

Output:
  projects/udu/runs/run-<timestamp>/
    decisions.csv     one row per cortex pick (time, gen, pick, target, ms, reason)
    deaths.csv        one row per death (gen, reason, lifespan, chunks, resources, lifeGoal, diagnosis)
    rules-by-gen/     rule snapshots: start.json + gen-N-death.json after each death
    summary.txt       aggregate text report

Stop condition: until-gen deaths observed, or Ctrl+C.
"""
import argparse
import csv
import json
import os
import re
import signal
import sqlite3
import subprocess
import sys
import time
import urllib.request
from datetime import datetime
from pathlib import Path

UDU_DIR = Path(__file__).resolve().parent.parent
DB_PATH = UDU_DIR / "data" / "udu.db"

CORTEX_RE = re.compile(
    r"\[llm\] cortex pick=(?P<pick>[a-z_]+)"
    r"(?: target=(?P<target>[A-Za-z0-9_]+))?"
    r" \((?P<ms>\d+)ms\) — (?P<reason>.+)$"
)
DEATH_RE = re.compile(
    r"character died id=(?P<id>\d+) iter=(?P<iter>\d+) reason=(?P<reason>[a-z_]+)"
    r" lifespan=(?P<gh>[\d.]+)gh at \((?P<x>[\d.]+),(?P<y>[\d.]+)\)"
)


def fetch_rules(port: int) -> dict:
    try:
        with urllib.request.urlopen(f"http://localhost:{port}/api/admin/rules", timeout=3) as r:
            return json.loads(r.read())
    except Exception as e:
        return {"error": str(e), "rules": []}


def fetch_character(port: int) -> dict:
    """Compact character snapshot at decision-time. Lag from log-line emission
    to HTTP fetch is much smaller than the cortex tick interval, so state
    nearly always reflects the moment the pick was made. Returns empty dict
    on failure (script keeps running)."""
    try:
        with urllib.request.urlopen(f"http://localhost:{port}/api/admin/character", timeout=2) as r:
            return json.loads(r.read())
    except Exception:
        return {}


def query_death_row(char_id: int) -> dict:
    con = sqlite3.connect(f"file:{DB_PATH}?mode=ro", uri=True)
    con.row_factory = sqlite3.Row
    try:
        row = con.execute(
            "SELECT iteration, death_reason, lifespan_game_hours, x, y, "
            "chunks_visited_at_death, resources_discovered_at_death, "
            "life_goal_text, life_goal_diagnosis "
            "FROM character WHERE id = ?",
            (char_id,),
        ).fetchone()
        return dict(row) if row else {}
    finally:
        con.close()


def write_summary(run_dir: Path, decisions_csv: Path, deaths_csv: Path, started_at: float, until_gen: int):
    pick_counts: dict[str, int] = {}
    total = 0
    with decisions_csv.open() as f:
        next(f, None)  # header
        for row in csv.reader(f):
            if len(row) < 3:
                continue
            pick_counts[row[2]] = pick_counts.get(row[2], 0) + 1
            total += 1

    lines = [
        "=== Udu observation run ===",
        f"Started: {datetime.fromtimestamp(started_at).isoformat(timespec='seconds')}",
        f"Ended:   {datetime.now().isoformat(timespec='seconds')}",
        f"Until-gen target: {until_gen}",
        f"Total decisions: {total}",
        "",
        "=== Decision distribution ===",
    ]
    for k, v in sorted(pick_counts.items(), key=lambda x: -x[1]):
        pct = 100.0 * v / total if total else 0
        lines.append(f"  {k:<24} {v:>5}  ({pct:5.1f}%)")
    lines.append("")
    lines.append("=== Deaths ===")
    if deaths_csv.exists():
        lines.append(deaths_csv.read_text().rstrip())
    lines.append("")
    lines.append("=== Rules by gen ===")
    for f in sorted((run_dir / "rules-by-gen").glob("*.json")):
        lines.append(f"[{f.stem}]")
        try:
            data = json.loads(f.read_text())
            for r in data.get("rules", []):
                lines.append(f"  ({r.get('confidence', 0):.2f}) {r.get('text', '')}")
        except Exception as e:
            lines.append(f"  (parse error: {e})")
        lines.append("")

    (run_dir / "summary.txt").write_text("\n".join(lines))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--until-gen", type=int, default=3, help="stop after N deaths (default 3)")
    ap.add_argument("--port", type=int, default=4246, help="frontend proxy port (default 4246)")
    args = ap.parse_args()

    ts = datetime.now().strftime("%Y-%m-%d-%H%M%S")
    run_dir = UDU_DIR / "runs" / f"run-{ts}"
    rules_dir = run_dir / "rules-by-gen"
    rules_dir.mkdir(parents=True, exist_ok=True)

    decisions_csv = run_dir / "decisions.csv"
    deaths_csv = run_dir / "deaths.csv"

    print(f"[observe] output: {run_dir}", flush=True)
    print(f"[observe] target: stop after {args.until_gen} death(s)", flush=True)

    # Start snapshot
    start_rules = fetch_rules(args.port)
    (rules_dir / "start.json").write_text(json.dumps(start_rules, indent=2))
    print(f"[observe] start rules: {len(start_rules.get('rules', []))} active", flush=True)

    # Open CSVs
    dec_f = decisions_csv.open("w", newline="")
    dec_w = csv.writer(dec_f)
    dec_w.writerow([
        "timestamp", "iter", "pick", "target", "duration_ms", "reasoning",
        "x", "y",
        "hp", "hunger", "thirst", "energy", "sickness", "bladder", "temperature",
        "current_action", "inventory", "daily_goal_step",
    ])
    dec_f.flush()

    death_f = deaths_csv.open("w", newline="")
    death_w = csv.writer(death_f)
    death_w.writerow([
        "iter", "reason", "lifespan_gh", "x", "y",
        "chunks_visited", "resources_discovered", "life_goal", "diagnosis",
    ])
    death_f.flush()

    started_at = time.time()
    death_count = 0

    # Spawn docker logs tail. --since=1s keeps backfill minimal.
    proc = subprocess.Popen(
        ["docker", "compose", "logs", "-f", "--no-log-prefix", "--since=0s", "backend"],
        cwd=str(UDU_DIR),
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        bufsize=1,
    )

    def cleanup(*_):
        try:
            proc.terminate()
        except Exception:
            pass
        dec_f.close()
        death_f.close()
        write_summary(run_dir, decisions_csv, deaths_csv, started_at, args.until_gen)
        print(f"[observe] summary: {run_dir / 'summary.txt'}", flush=True)
        sys.exit(0)

    signal.signal(signal.SIGINT, cleanup)
    signal.signal(signal.SIGTERM, cleanup)

    try:
        for raw in proc.stdout:
            line = raw.rstrip("\n")

            m = CORTEX_RE.search(line)
            if m:
                ts_now = datetime.now().isoformat(timespec="seconds")
                ch = fetch_character(args.port)
                stats = ch.get("stats") or {}
                dec_w.writerow([
                    ts_now,
                    ch.get("iteration", ""),
                    m["pick"],
                    m["target"] or "",
                    m["ms"],
                    m["reason"].strip(),
                    round(ch["x"], 2) if "x" in ch else "",
                    round(ch["y"], 2) if "y" in ch else "",
                    round(stats.get("health", 0), 1) if stats else "",
                    round(stats.get("hunger", 0), 1) if stats else "",
                    round(stats.get("thirst", 0), 1) if stats else "",
                    round(stats.get("energy", 0), 1) if stats else "",
                    round(stats.get("sickness", 0), 1) if stats else "",
                    round(stats.get("bladder", 0), 1) if stats else "",
                    round(stats.get("temperature", 0), 1) if stats else "",
                    ch.get("currentAction", ""),
                    "|".join(ch.get("inventory", []) or []),
                    ch.get("dailyGoalStep", "") or "",
                ])
                dec_f.flush()
                continue

            m = DEATH_RE.search(line)
            if m:
                cid = int(m["id"])
                death_count += 1
                print(f"[observe] death {death_count}/{args.until_gen}: gen={m['iter']} reason={m['reason']} lifespan={m['gh']}gh", flush=True)
                row = query_death_row(cid)
                death_w.writerow([
                    row.get("iteration", m["iter"]),
                    row.get("death_reason", m["reason"]),
                    row.get("lifespan_game_hours", m["gh"]),
                    row.get("x", m["x"]),
                    row.get("y", m["y"]),
                    row.get("chunks_visited_at_death", ""),
                    row.get("resources_discovered_at_death", ""),
                    row.get("life_goal_text", "") or "",
                    row.get("life_goal_diagnosis", "") or "",
                ])
                death_f.flush()
                # Snapshot rules
                snap = fetch_rules(args.port)
                (rules_dir / f"gen-{m['iter']}-death.json").write_text(json.dumps(snap, indent=2))

                if death_count >= args.until_gen:
                    print("[observe] target reached, stopping tail and writing summary...", flush=True)
                    break
    finally:
        cleanup()


if __name__ == "__main__":
    main()
