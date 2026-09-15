"""
Pure ranking logic for the Felkapott (trending) catalogs. No network and no I/O apart from
the optional state file, so everything here is unit-testable (scripts/tests/test_trending_rank.py).

Model:

* A *release* is one nCore torrent: seeds, leechers, upload date.
* Releases of the same title (same IMDb id; for series the same IMDb id + episode) are
  grouped: seeds and leechers are summed, the age is measured from the earliest upload.
  A film uploaded as WEB-DL, BluRay and x265 no longer has its peers split three ways.
* Score = (seeds + LEECH_WEIGHT * leechers) / (age_days + AGE_OFFSET) ** GRAVITY.
  Leechers are current demand (the closest nCore analogue to "being watched right now").
  The sub-linear decay (Hacker News style gravity) keeps a 1000-seed title from 13 days ago
  above a 150-seed one from this morning, while a genuinely hot new upload still reaches the top.
* Momentum (phase 2): a small state file keeps per-title peer samples from previous runs;
  when enabled, titles are ranked by how many peers they gained over the last
  MOMENTUM_WINDOW_HOURS (the TMDB "previous day's score" idea). Titles without usable
  history fall back to the score above.
"""
import json
import os
from datetime import datetime, timezone

GRAVITY = float(os.getenv('NCORE_TRENDING_GRAVITY', '0.7'))
LEECH_WEIGHT = float(os.getenv('NCORE_TRENDING_LEECH_WEIGHT', '2'))
AGE_OFFSET = float(os.getenv('NCORE_TRENDING_AGE_OFFSET', '2'))
# Momentum: compare against a sample at least MIN_HOURS old and at most WINDOW_HOURS old.
MOMENTUM_WINDOW_HOURS = float(os.getenv('NCORE_TRENDING_MOMENTUM_WINDOW_HOURS', '48'))
MOMENTUM_MIN_HOURS = float(os.getenv('NCORE_TRENDING_MOMENTUM_MIN_HOURS', '18'))
STATE_KEEP_HOURS = float(os.getenv('NCORE_TRENDING_STATE_KEEP_HOURS', '96'))


def _to_int(v):
    try:
        return int(v or 0)
    except (TypeError, ValueError):
        return 0


def _field(t, *names):
    """First non-empty value of the given field names on a dict or an ncoreparser Torrent."""
    for n in names:
        v = None
        if isinstance(t, dict):
            v = t.get(n)
        else:
            try:
                v = t[n]
            except (KeyError, TypeError, IndexError):
                v = getattr(t, n, None)
        if v not in (None, ''):
            return v
    return None


def peers_from_torrent(t):
    """(seeds, leechers) of an ncoreparser torrent (list items expose 'seed' / 'leech' strings)."""
    return (
        _to_int(_field(t, 'seeders', 'seed_count', 'seed')),
        _to_int(_field(t, 'leechers', 'leech_count', 'leech')),
    )


def upload_datetime(t):
    """Upload datetime of a torrent (ncoreparser parses it into a naive local datetime), or None."""
    d = _field(t, 'date')
    return d if isinstance(d, datetime) else None


def days_since(dt, now=None):
    """Days between dt and now (>= 0), or None when dt is missing."""
    if dt is None:
        return None
    now = now or (datetime.now(dt.tzinfo) if dt.tzinfo else datetime.now())
    return max((now - dt).total_seconds() / 86400.0, 0.0)


def peer_weight(seeds, leech, leech_weight=None):
    w = LEECH_WEIGHT if leech_weight is None else leech_weight
    return float(seeds) + w * float(leech)


def hot_score(seeds, leech, age_days, gravity=None, leech_weight=None, age_offset=None):
    """(seeds + w*leech) / (age + offset) ** gravity. Missing age counts as a fresh upload (age 0)."""
    g = GRAVITY if gravity is None else gravity
    o = AGE_OFFSET if age_offset is None else age_offset
    age = max(float(age_days or 0.0), 0.0)
    return peer_weight(seeds, leech, leech_weight) / ((age + o) ** g)


def group_releases(releases):
    """
    Merge releases (dicts with key, seeds, leech, age_days, plus anything else) by key.
    Returns {key: {'key', 'seeds', 'leech', 'age_days', 'releases', 'items'}} where seeds/leech
    are sums, age_days is the earliest upload (largest age; None when no release had a date)
    and items keeps the source releases, newest first, so callers can pick metadata from them.
    """
    groups = {}
    for r in releases:
        key = r['key']
        g = groups.get(key)
        if g is None:
            g = groups[key] = {'key': key, 'seeds': 0, 'leech': 0, 'age_days': None, 'releases': 0, 'items': []}
        g['seeds'] += _to_int(r.get('seeds'))
        g['leech'] += _to_int(r.get('leech'))
        g['releases'] += 1
        g['items'].append(r)
        age = r.get('age_days')
        if age is not None and (g['age_days'] is None or age > g['age_days']):
            g['age_days'] = age
    for g in groups.values():
        g['items'].sort(key=lambda r: (r.get('age_days') if r.get('age_days') is not None else float('inf')))
    return groups


def rank_groups(groups, min_seeds=0, scorer=None):
    """Score every group (scorer(group) -> float; default hot_score), drop those under min_seeds, sort desc."""
    scorer = scorer or (lambda g: hot_score(g['seeds'], g['leech'], g['age_days']))
    ranked = []
    for g in (groups.values() if isinstance(groups, dict) else groups):
        if g['seeds'] < min_seeds:
            continue
        g = dict(g)
        g['score'] = round(scorer(g), 3)
        ranked.append(g)
    ranked.sort(key=lambda g: (g['score'], g['seeds']), reverse=True)
    return ranked


def select_with_floor(ranked, min_seeds, count):
    """
    The top `count` groups of a ranked list, preferring those with at least min_seeds seeds.
    When fewer than `count` titles reach the floor the best of the rest (still in score
    order) fill the remaining slots, so the catalog never shows a short list in a quiet week.
    Returns (selected, backfilled_count).
    """
    above = [g for g in ranked if g['seeds'] >= min_seeds]
    below = [g for g in ranked if g['seeds'] < min_seeds]
    selected = above[:count]
    backfill = below[:max(count - len(selected), 0)]
    return selected + backfill, len(backfill)


class TrendingState:
    """
    Per-title peer samples from previous runs: {key: [[unix_hours, seeds, leech], ...]}.
    Persisted as data/trending_state.json by the workflow so the next run can measure momentum.
    """

    def __init__(self, samples=None):
        self.samples = samples or {}

    @classmethod
    def load(cls, path):
        try:
            with open(path, encoding='utf-8') as f:
                data = json.load(f)
            samples = data.get('samples') if isinstance(data, dict) else None
            return cls(samples if isinstance(samples, dict) else {})
        except (OSError, ValueError):
            return cls({})

    def save(self, path):
        with open(path, 'w', encoding='utf-8') as f:
            json.dump(
                {'updated_at': datetime.now(timezone.utc).isoformat(timespec='seconds'), 'samples': self.samples},
                f, ensure_ascii=False, separators=(',', ':'), sort_keys=True,
            )

    @staticmethod
    def _hours(now):
        now = now or datetime.now(timezone.utc)
        if now.tzinfo is None:
            now = now.replace(tzinfo=timezone.utc)
        return now.timestamp() / 3600.0

    def record(self, key, seeds, leech, now=None):
        self.samples.setdefault(key, []).append([round(self._hours(now), 2), _to_int(seeds), _to_int(leech)])

    def prune(self, now=None, keep_hours=None):
        """Drop samples older than keep_hours and titles left without samples."""
        cutoff = self._hours(now) - (STATE_KEEP_HOURS if keep_hours is None else keep_hours)
        for key in list(self.samples):
            kept = [s for s in self.samples[key] if isinstance(s, list) and len(s) == 3 and s[0] >= cutoff]
            if kept:
                self.samples[key] = kept
            else:
                del self.samples[key]

    def baseline(self, key, now=None, window_hours=None, min_hours=None):
        """Oldest sample inside [now - window, now - min_hours], or None. Call before record()."""
        h = self._hours(now)
        window = MOMENTUM_WINDOW_HOURS if window_hours is None else window_hours
        min_h = MOMENTUM_MIN_HOURS if min_hours is None else min_hours
        candidates = [
            s for s in self.samples.get(key, [])
            if isinstance(s, list) and len(s) == 3 and (h - window) <= s[0] <= (h - min_h)
        ]
        return min(candidates, key=lambda s: s[0]) if candidates else None

    def gain(self, key, seeds, leech, age_days, now=None, window_hours=None, min_hours=None):
        """
        Peer weight gained over the momentum window, or None when it cannot be measured.
        A title uploaded inside the window with no history gained everything it has.
        """
        base = self.baseline(key, now, window_hours, min_hours)
        current = peer_weight(seeds, leech)
        if base is not None:
            return current - peer_weight(base[1], base[2])
        window = MOMENTUM_WINDOW_HOURS if window_hours is None else window_hours
        if age_days is not None and age_days * 24.0 <= window:
            return current
        return None


def momentum_scorer(state, now=None):
    """Scorer for rank_groups: momentum gain when measurable, otherwise the hot score."""
    def score(g):
        gain = state.gain(g['key'], g['seeds'], g['leech'], g['age_days'], now)
        if gain is None:
            return hot_score(g['seeds'], g['leech'], g['age_days'])
        return max(gain, 0.0)
    return score
