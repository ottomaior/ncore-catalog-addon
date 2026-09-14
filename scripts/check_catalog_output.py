"""
Guard for the data workflows: refuse to commit a catalog file that is missing, invalid,
empty, or shrank sharply compared with the committed version. A silent failure in a
build script would otherwise be pushed and served for days.

Usage: python scripts/check_catalog_output.py data/hd_movies.json data/hd_series.json
Exit code 1 (and a summary) on any problem; GitHub Actions then marks the run failed
and sends the repository owner a failure notification.

Env: CATALOG_GUARD_MAX_SHRINK (default 0.5 = fail if the list lost more than half its
items; only enforced when the previous file had at least CATALOG_GUARD_MIN_ITEMS items).
"""
import json
import os
import subprocess
import sys

MAX_SHRINK = float(os.getenv('CATALOG_GUARD_MAX_SHRINK', '0.5'))
MIN_ITEMS = int(os.getenv('CATALOG_GUARD_MIN_ITEMS', '20'))
REQUIRED_KEYS = ('id', 'type', 'name')


def load_current(path):
    with open(path, encoding='utf-8') as f:
        data = json.load(f)
    if not isinstance(data, list):
        raise ValueError('not a JSON array')
    return data


def load_committed(path):
    """Items in the committed version of the file (git HEAD), or None when untracked."""
    try:
        out = subprocess.run(
            ['git', 'show', f'HEAD:{path.replace(os.sep, "/")}'],
            capture_output=True, text=True, encoding='utf-8', check=True,
        ).stdout
        data = json.loads(out)
        return data if isinstance(data, list) else None
    except (subprocess.CalledProcessError, json.JSONDecodeError, OSError):
        return None


def check_file(path, committed=None):
    """Return a list of problems for one file (empty list = OK)."""
    problems = []
    if not os.path.exists(path):
        return [f'{path}: file missing']
    try:
        current = load_current(path)
    except (ValueError, json.JSONDecodeError) as e:
        return [f'{path}: invalid JSON ({e})']
    if not current:
        return [f'{path}: empty list']
    bad = [i for i, m in enumerate(current) if not isinstance(m, dict) or any(not m.get(k) for k in REQUIRED_KEYS)]
    if bad:
        problems.append(f'{path}: {len(bad)} item(s) missing id/type/name (first at index {bad[0]})')
    if committed is None:
        committed = load_committed(path)
    if committed and len(committed) >= MIN_ITEMS:
        allowed = int(len(committed) * (1 - MAX_SHRINK))
        if len(current) < allowed:
            problems.append(f'{path}: shrank from {len(committed)} to {len(current)} items (limit {allowed})')
    return problems


def main(paths):
    if not paths:
        print('usage: check_catalog_output.py <json file> [...]')
        return 2
    all_problems = []
    for p in paths:
        probs = check_file(p)
        status = 'FAIL' if probs else 'ok'
        print(f'[{status}] {p}')
        all_problems.extend(probs)
    if all_problems:
        print('\nCatalog guard failed:')
        for p in all_problems:
            print(f'  - {p}')
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
