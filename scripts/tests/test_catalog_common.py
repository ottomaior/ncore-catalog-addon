import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import catalog_common as cc  # noqa: E402


@pytest.mark.parametrize('title, expected', [
    ('Dune.Part.Two.2024.1080p.BluRay.x264-HUN', ('Dune Part Two', '2024')),
    ('Oppenheimer.2023.HUN.1080p.WEB-DL.DDP5.1.H.264', ('Oppenheimer', '2023')),
    ('Some.Movie.Without.Year.1080p', ('Some Movie Without Year', None)),
    ('Alba Vulva 1080p', ('Alba Vulva', None)),
    ('Tragacsparádé 1080p REMUX', ('Tragacsparádé', None)),
    ('Szeurum.1080p.WEB-DL.HUN', ('Szeurum', None)),
    ('Fukusima - Döntés nyomás alatt 1080i', ('Fukusima - Döntés nyomás alatt', None)),
    ('Hunter.Killer.1080p', ('Hunter Killer', None)),  # 'HUN' inside a word is not a marker
    ('1080p', ('1080p', None)),  # nothing before the marker -> keep original
    ('', ('', None)),
])
def test_parse_movie_title(title, expected):
    assert cc.parse_movie_title(title) == expected


@pytest.mark.parametrize('title, expected', [
    ('Fallout.S02.AMZN.WEB-DL.1080p', ('Fallout', None)),
    ('Fallout S02 AMZN WEB DL 1080p', ('Fallout', None)),
    ('The.Bear.2022.S03E01.1080p.WEB.H264-HUN', ('The Bear', '2022')),
    ('Veronika.S03E02.720p.HDTV', ('Veronika', None)),
    ('Show.Name.HDR.2160p', ('Show Name', None)),
    ('.S01E01', ('.S01E01', None)),  # nothing before the marker -> keep original
    ('', ('', None)),
])
def test_parse_series_title(title, expected):
    assert cc.parse_series_title(title) == expected


def test_extract_episode_info():
    assert cc.extract_episode_info('Show.S02E03.720p') == (2, 3, 'S02E03')
    assert cc.extract_episode_info('show.s1e5') == (1, 5, 'S01E05')
    assert cc.extract_episode_info('Movie.2024') == (None, None, None)
    assert cc.extract_episode_info(None) == (None, None, None)


def test_is_newer_episode():
    assert cc.is_newer_episode(2, 1, 1, 9)
    assert cc.is_newer_episode(1, 2, 1, 1)
    assert not cc.is_newer_episode(1, 1, 1, 1)
    assert not cc.is_newer_episode(1, 1, 2, 1)
    assert cc.is_newer_episode(1, 1, None, None)
    assert not cc.is_newer_episode(None, 1, 1, 1)


def test_is_likely_series_and_sports():
    assert cc.is_likely_series('Show.S01E01')
    assert cc.is_likely_series('Show.S02.Complete')
    assert not cc.is_likely_series('Movie.2024.1080p')
    assert not cc.is_likely_series('')
    assert cc.is_sports_content('UEFA.Champions.League.2024')
    assert cc.is_sports_content('Forma-1 Magyar Nagydíj')
    assert not cc.is_sports_content('The.Bear.S03E01')


class _Torrent:
    def __init__(self, seed):
        self._seed = seed

    def __getitem__(self, key):
        if key == 'seed':
            return self._seed
        raise KeyError(key)


def test_seeders_from_torrent():
    assert cc.seeders_from_torrent({'seed': '12'}) == 12
    assert cc.seeders_from_torrent({'seeders': 7}) == 7
    assert cc.seeders_from_torrent({}) == 0
    assert cc.seeders_from_torrent(_Torrent('42')) == 42
    assert cc.seeders_from_torrent(_Torrent('n/a')) == 0
    assert cc.seeders_from_torrent(None) == 0


def test_fmt_rating():
    assert cc.fmt_rating(None) == '?'
    assert cc.fmt_rating(7.456) == '7.5'


def test_pick_best_tmdb_result_prefers_title_and_year_over_position():
    results = [
        {'id': 1, 'title': 'Dűne', 'original_title': 'Dune', 'release_date': '1984-12-14', 'popularity': 50},
        {'id': 2, 'title': 'Dűne', 'original_title': 'Dune', 'release_date': '2021-10-22', 'popularity': 200},
        {'id': 3, 'title': 'Dűne: Második rész', 'original_title': 'Dune: Part Two', 'release_date': '2024-02-27', 'popularity': 300},
    ]
    assert cc.pick_best_tmdb_result(results, 'Dune Part Two', '2024')['id'] == 3
    assert cc.pick_best_tmdb_result(results, 'Dune', '2021')['id'] == 2
    assert cc.pick_best_tmdb_result(results, 'Dune', '1984')['id'] == 1
    # Without a year the exact title wins and popularity breaks the tie.
    assert cc.pick_best_tmdb_result(results, 'Dune', None)['id'] == 2
    assert cc.pick_best_tmdb_result([], 'Dune', None) is None


class _Resp:
    def __init__(self, status_code, payload):
        self.status_code = status_code
        self._payload = payload

    def json(self):
        return self._payload


class _FakeSession:
    """Minimal requests-like session returning canned TMDB answers."""

    def __init__(self):
        self.calls = []

    def get(self, url, params=None, timeout=None):
        self.calls.append((url, params))
        if url == cc.TMDB_SEARCH_URL:
            return _Resp(200, {'results': [
                {'id': 10, 'title': 'Más film', 'original_title': 'Other Movie', 'release_date': '2020-01-01'},
                {'id': 11, 'title': 'A film', 'original_title': 'The Movie', 'release_date': '2023-05-05'},
            ]})
        if url == cc.TMDB_MOVIE_URL.format(tmdb_id=11):
            return _Resp(200, {
                'imdb_id': 'tt0000011', 'title': 'A film', 'poster_path': '/p.jpg',
                'genres': [{'name': 'Dráma'}], 'overview': 'leírás', 'release_date': '2023-05-05', 'vote_average': 7.1,
            })
        return _Resp(404, {})


def test_search_movie_on_tmdb_uses_scoring_and_returns_metadata():
    session = _FakeSession()
    meta = cc.search_movie_on_tmdb('The Movie', '2023', 'key', delay=0, session=session)
    assert meta == {
        'imdb_id': 'tt0000011', 'title': 'A film', 'poster_path': '/p.jpg', 'genres': ['Dráma'],
        'description': 'leírás', 'year': 2023, 'rating': 7.1,
    }
    assert session.calls[0][1]['query'] == 'The Movie'
    assert session.calls[0][1]['year'] == '2023'


def test_search_movie_on_tmdb_without_key_or_title():
    assert cc.search_movie_on_tmdb('X', None, None, delay=0) is None
    assert cc.search_movie_on_tmdb('', None, 'key', delay=0) is None


def test_series_release_info():
    assert cc.series_release_info({'first_air_date': '2019-03-01', 'status': 'Returning Series'}) == '2019-'
    assert cc.series_release_info({'first_air_date': '2019-03-01', 'last_air_date': '2023-05-05', 'status': 'Ended'}) == '2019-2023'
    assert cc.series_release_info({'first_air_date': '2019-03-01', 'last_air_date': '2019-12-05', 'status': 'Canceled'}) == '2019'
    assert cc.series_release_info({'year': 2010, 'last_air_date': '2026-09-01'}) == '2010-'
    assert cc.series_release_info({'year': 2010}) == '2010'
    assert cc.series_release_info({}) is None


def test_is_recently_aired():
    from datetime import date
    today = date(2026, 9, 14)
    assert cc.is_recently_aired({'last_air_date': '2026-09-01'}, 365, today)
    assert cc.is_recently_aired({'last_air_date': '2025-10-01'}, 365, today)
    assert not cc.is_recently_aired({'last_air_date': '2004-06-01'}, 365, today)
    assert not cc.is_recently_aired({'last_air_date': '2025-09-01'}, 365, today)
    assert cc.is_recently_aired({}, 365, today)  # unknown -> keep
    assert cc.is_recently_aired({'last_air_date': 'garbage'}, 365, today)


class _ImageSession:
    def __init__(self):
        self.calls = 0

    def get(self, url, params=None, timeout=None):
        self.calls += 1
        if url == cc.TMDB_FIND_URL.format(imdb_id='tt1'):
            return _Resp(200, {'movie_results': [{'id': 77}], 'tv_results': []})
        if url == cc.TMDB_IMAGES_URL.format(media_type='movie', tmdb_id=77):
            return _Resp(200, {
                'backdrops': [
                    {'file_path': '/en.jpg', 'iso_639_1': 'en', 'vote_average': 9},
                    {'file_path': '/textless.jpg', 'iso_639_1': None, 'vote_average': 5},
                ],
                'logos': [
                    {'file_path': '/logo-en.png', 'iso_639_1': 'en', 'vote_average': 9},
                    {'file_path': '/logo-hu.png', 'iso_639_1': 'hu', 'vote_average': 1},
                ],
            })
        return _Resp(404, {})


def test_fetch_tmdb_images_prefers_textless_backdrop_and_hungarian_logo():
    img = cc.fetch_tmdb_images('tt1', 'movie', 'key', delay=0, session=_ImageSession())
    assert img == {'background': cc.TMDB_BACKDROP_PREFIX + '/textless.jpg', 'logo': cc.TMDB_LOGO_PREFIX + '/logo-hu.png'}
    assert cc.fetch_tmdb_images('tt404', 'movie', 'key', delay=0, session=_ImageSession()) is None
    assert cc.fetch_tmdb_images('tt1', 'movie', None, delay=0) is None


def test_add_images_reuses_previous_and_respects_cap():
    session = _ImageSession()
    previous = [{'id': 'tt9', 'background': 'https://x/bg.jpg', 'logo': None}]
    metas = [
        {'id': 'tt9', 'name': 'cached'},
        {'id': 'tt1', 'name': 'new'},
        {'id': 'tt2', 'name': 'over cap'},
        {'id': 'tt3', 'name': 'already', 'background': 'https://x/own.jpg'},
    ]
    fetched = cc.add_images(metas, 'movie', 'key', previous=previous, max_per_run=1, delay=0, session=session, log=lambda *_: None)
    assert fetched == 1
    assert metas[0]['background'] == 'https://x/bg.jpg'          # from previous JSON, no call
    assert metas[1]['background'].endswith('/textless.jpg')     # fetched
    assert 'background' not in metas[2]                          # cap reached
    assert metas[3]['background'] == 'https://x/own.jpg'         # untouched
    assert session.calls == 2                                    # find + images for tt1 only
