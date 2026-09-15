import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import tvdb_client as tc  # noqa: E402


def test_pick_localized_prefers_hungarian_then_english_then_original():
    assert tc.pick_localized('Tökéletes világ', 'TVDB hu', 'Perfect World', '完美世界') == 'Tökéletes világ'
    assert tc.pick_localized(None, 'TVDB hu', 'Perfect World', '完美世界') == 'TVDB hu'
    assert tc.pick_localized(None, '', 'Perfect World', '完美世界') == 'Perfect World'
    assert tc.pick_localized(None, None, '  ', '完美世界') == '完美世界'
    assert tc.pick_localized(None, None, None, None) == ''


def test_translation_reads_appended_tmdb_translations():
    tv = {'translations': {'translations': [
        {'iso_639_1': 'sv', 'data': {'name': 'Dino - vägen mot Formel 1', 'overview': 'sv'}},
        {'iso_639_1': 'en', 'data': {'name': 'Dino: Road to Formula 1', 'overview': ''}},
    ]}}
    assert tc._translation(tv, 'en') == ('Dino: Road to Formula 1', '')
    assert tc._translation(tv, 'hu') == ('', '')


def test_rank_tvdb_results_prefers_title_match_over_listing_order():
    results = [
        {'name': 'The Perfect House', 'year': '2008', 'remote_ids': []},
        {'name': '라이어', 'year': '2026', 'aliases': ['Liar (2026)'], 'translations': {'eng': 'The Perfect Lie'}},
        {'name': '完美世界', 'year': '2021', 'aliases': ['Wanmei Shijie'], 'translations': {'eng': 'Perfect World (2021)'},
         'remote_ids': [{'id': 'tt14986786', 'sourceName': 'IMDB'}]},
        {'name': 'The Perfect Couple', 'year': '2024'},
    ]
    ranked = tc.rank_tvdb_results(results, 'The Perfect Lie', None)
    assert ranked[0]['name'] == '라이어'
    # an exact match exists, so merely similar shows are dropped rather than used as fallback
    assert [c['name'] for c in ranked] == ['라이어']


def test_rank_tvdb_results_uses_year_to_break_ties():
    results = [
        {'name': 'Formula 1', 'year': '1950'},
        {'name': 'Formula 1 Academy', 'year': '2023'},
        {'name': 'Dino - vägen mot Formel 1', 'year': '2026'},
    ]
    ranked = tc.rank_tvdb_results(results, 'Formula 1', 2026)
    assert ranked[0]['name'] == 'Formula 1'
    assert all('Dino' not in c['name'] for c in ranked)
    assert tc.rank_tvdb_results([], 'x', None) == []
