import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import trending_rank as tr  # noqa: E402


class FakeTorrent:
    """Mimics ncoreparser.Torrent: item access only, values are strings."""

    def __init__(self, **d):
        self._d = d

    def __getitem__(self, k):
        return self._d[k]


def test_peers_from_torrent_reads_strings_and_dicts():
    assert tr.peers_from_torrent(FakeTorrent(seed='12', leech='3')) == (12, 3)
    assert tr.peers_from_torrent({'seed': '0', 'leech': ''}) == (0, 0)
    assert tr.peers_from_torrent({'seeders': 7}) == (7, 0)
    assert tr.peers_from_torrent(FakeTorrent(title='x')) == (0, 0)


def test_upload_datetime_and_days_since():
    dt = datetime(2026, 9, 1, 12, 0)
    assert tr.upload_datetime(FakeTorrent(date=dt)) == dt
    assert tr.upload_datetime(FakeTorrent(date='2026-09-01')) is None
    assert tr.days_since(None) is None
    assert tr.days_since(dt, now=dt + timedelta(days=2, hours=12)) == 2.5
    assert tr.days_since(dt, now=dt - timedelta(hours=1)) == 0.0


def test_hot_score_prefers_established_title_over_fresh_trickle():
    # The linear seeds/(age+1) formula ranked 150 seeds at 0.5 days (100) above 1000 seeds at 10 days (91).
    old_popular = tr.hot_score(1000, 0, 10, gravity=0.7, leech_weight=2, age_offset=2)
    fresh_small = tr.hot_score(150, 0, 0.5, gravity=0.7, leech_weight=2, age_offset=2)
    assert old_popular > fresh_small
    # ...while a genuinely hot new upload still tops a 13-day-old 1000-seed title.
    hot_new = tr.hot_score(400, 150, 0.25, gravity=0.7, leech_weight=2, age_offset=2)
    old_13d = tr.hot_score(1000, 0, 13, gravity=0.7, leech_weight=2, age_offset=2)
    assert hot_new > old_13d


def test_hot_score_counts_leechers_and_handles_missing_age():
    assert tr.hot_score(10, 5, 0, leech_weight=2, age_offset=2, gravity=1) == 10.0
    assert tr.hot_score(10, 0, None, leech_weight=2, age_offset=2, gravity=1) == 5.0


def test_group_releases_sums_peers_and_uses_earliest_upload():
    groups = tr.group_releases([
        {'key': 'tt1', 'seeds': 100, 'leech': 10, 'age_days': 1.0, 'tag': 'x265'},
        {'key': 'tt1', 'seeds': 300, 'leech': 40, 'age_days': 4.0, 'tag': 'bluray'},
        {'key': 'tt1', 'seeds': '5', 'leech': None, 'age_days': None, 'tag': 'nodate'},
        {'key': 'tt2', 'seeds': 50, 'leech': 0, 'age_days': None},
    ])
    g = groups['tt1']
    assert (g['seeds'], g['leech'], g['releases'], g['age_days']) == (405, 50, 3, 4.0)
    assert [r['tag'] for r in g['items']] == ['x265', 'bluray', 'nodate']  # newest first, undated last
    assert groups['tt2']['age_days'] is None


def test_rank_groups_applies_floor_and_sorts_by_score():
    groups = tr.group_releases([
        {'key': 'a', 'seeds': 1000, 'leech': 0, 'age_days': 10},
        {'key': 'b', 'seeds': 150, 'leech': 0, 'age_days': 0.5},
        {'key': 'c', 'seeds': 20, 'leech': 500, 'age_days': 0.1},  # under the seed floor
    ])
    ranked = tr.rank_groups(groups, min_seeds=40)
    assert [g['key'] for g in ranked] == ['a', 'b']
    assert all('score' in g for g in ranked)
    # a custom scorer is honoured
    assert [g['key'] for g in tr.rank_groups(groups, min_seeds=0, scorer=lambda g: g['leech'])] == ['c', 'a', 'b']


def test_state_roundtrip_and_prune(tmp_path):
    now = datetime(2026, 9, 15, 12, 0, tzinfo=timezone.utc)
    st = tr.TrendingState()
    st.record('tt1', 10, 2, now=now - timedelta(hours=100))
    st.record('tt1', 20, 4, now=now - timedelta(hours=30))
    st.record('tt2', 5, 0, now=now - timedelta(hours=200))
    st.prune(now=now, keep_hours=96)
    assert set(st.samples) == {'tt1'} and len(st.samples['tt1']) == 1
    path = tmp_path / 'state.json'
    st.save(path)
    loaded = tr.TrendingState.load(path)
    assert loaded.samples == st.samples
    assert tr.TrendingState.load(tmp_path / 'missing.json').samples == {}


def test_momentum_gain_uses_baseline_inside_window():
    now = datetime(2026, 9, 15, 12, 0, tzinfo=timezone.utc)
    st = tr.TrendingState()
    st.record('tt1', 100, 10, now=now - timedelta(hours=60))   # too old for a 48 h window
    st.record('tt1', 200, 20, now=now - timedelta(hours=40))   # oldest usable sample
    st.record('tt1', 260, 30, now=now - timedelta(hours=6))    # too recent (min 18 h)
    gain = st.gain('tt1', 300, 50, age_days=20, now=now, window_hours=48, min_hours=18)
    assert gain == (300 + 2 * 50) - (200 + 2 * 20)
    # No history: a title uploaded inside the window gained everything it has...
    assert st.gain('new', 80, 10, age_days=1, now=now, window_hours=48, min_hours=18) == 100
    # ...an old title without history cannot be measured.
    assert st.gain('old', 80, 10, age_days=5, now=now, window_hours=48, min_hours=18) is None


def test_momentum_scorer_falls_back_to_hot_score():
    now = datetime(2026, 9, 15, 12, 0, tzinfo=timezone.utc)
    st = tr.TrendingState()
    st.record('tt1', 100, 0, now=now - timedelta(hours=24))
    scorer = tr.momentum_scorer(st, now=now)
    assert scorer({'key': 'tt1', 'seeds': 90, 'leech': 0, 'age_days': 10}) == 0.0  # lost peers -> clamped
    assert scorer({'key': 'tt1', 'seeds': 150, 'leech': 5, 'age_days': 10}) == 60.0
    fallback = {'key': 'tt9', 'seeds': 500, 'leech': 0, 'age_days': 10}
    assert scorer(fallback) == tr.hot_score(500, 0, 10)
