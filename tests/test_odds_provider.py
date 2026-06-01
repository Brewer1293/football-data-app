from contextlib import closing
from datetime import date

from football_value_app.db import connect
from football_value_app.odds_provider import (
    _provider_error_message,
    _parse_live_quotes,
    _parse_odds_api_io_quotes,
    _parse_prematch_quotes,
    _normalized_team,
    best_quotes,
    save_quotes,
)


def test_prematch_parser_and_snapshot_storage(tmp_path):
    payload = {
        "response": [
            {
                "update": "2026-05-31T12:00:00+00:00",
                "bookmakers": [
                    {
                        "name": "Book A",
                        "bets": [
                            {
                                "id": 5,
                                "values": [
                                    {"value": "Over 1.5", "odd": "1.44"},
                                    {"value": "Over 2.5", "odd": "2.08"},
                                ],
                            }
                        ],
                    },
                    {
                        "name": "Book B",
                        "bets": [
                            {
                                "id": 5,
                                "values": [{"value": "Over 2.5", "odd": "2.15"}],
                            }
                        ],
                    },
                ],
            }
        ]
    }
    quotes = _parse_prematch_quotes(
        payload, 123, date(2026, 6, 11), "Mexico", "South Africa"
    )
    assert len(quotes) == 3
    assert best_quotes(quotes)["over_2_5"].decimal_odds == 2.15
    assert save_quotes(tmp_path / "test.db", quotes) == 3
    with closing(connect(tmp_path / "test.db")) as connection:
        assert connection.execute("SELECT COUNT(*) FROM provider_odds_snapshots").fetchone()[0] == 3


def test_live_parser_reads_supported_goal_lines():
    payload = {
        "response": [
            {
                "update": "2026-06-11T20:00:00+00:00",
                "odds": [
                    {
                        "name": "Over/Under Line",
                        "values": [
                            {"value": "Over", "odd": "1.70", "handicap": "1.5", "suspended": False},
                            {"value": "Over", "odd": "2.40", "handicap": "2.5", "suspended": False},
                            {"value": "Under", "odd": "1.50", "handicap": "2.5", "suspended": False},
                        ],
                    }
                ],
            }
        ]
    }
    quotes = _parse_live_quotes(
        payload, 456, date(2026, 6, 11), "Mexico", "South Africa"
    )
    assert [quote.market for quote in quotes] == ["over_1_5", "over_2_5"]
    assert all(quote.is_live for quote in quotes)


def test_provider_error_message_flattens_api_error_dictionary():
    message = _provider_error_message(
        {"plan": "Free plans do not have access to this date, try from 2026-05-30 to 2026-06-01."}
    )
    assert message.startswith("Free plans do not have access to this date")


def test_odds_api_io_parser_reads_bet365_world_cup_totals():
    payload = {
        "id": 66456904,
        "status": "pending",
        "bookmakers": {
            "Bet365": [
                {
                    "name": "Goals Over/Under",
                    "updatedAt": "2026-05-29T20:42:33.52Z",
                    "odds": [{"hdp": 2.5, "over": "2.100", "under": "1.727"}],
                },
                {
                    "name": "Alternative Goal Line",
                    "updatedAt": "2026-05-31T20:03:56.347Z",
                    "odds": [{"hdp": 1.5, "over": "1.350", "under": "3.100"}],
                },
            ]
        },
    }
    quotes = _parse_odds_api_io_quotes(
        payload, date(2026, 6, 11), "Mexico", "South Africa"
    )
    best = best_quotes(quotes)
    assert best["over_1_5"].decimal_odds == 1.35
    assert best["over_2_5"].decimal_odds == 2.10
    assert all(quote.provider == "odds-api.io" for quote in quotes)


def test_team_aliases_match_world_cup_schedule_to_odds_feed():
    assert _normalized_team("South Korea") == _normalized_team("Korea Republic")
    assert _normalized_team("Czech Republic") == _normalized_team("Czechia")
    assert _normalized_team("Bosnia & Herzegovina") == _normalized_team("Bosnia and Herzegovina")
    assert _normalized_team("Turkey") == _normalized_team("Turkiye")
    assert _normalized_team("Curaçao") == _normalized_team("Curacao")
