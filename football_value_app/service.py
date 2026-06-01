from __future__ import annotations

import sqlite3
from dataclasses import asdict
from pathlib import Path

from football_value_app.db import database
from football_value_app.model import MODEL_VERSION, estimate_probabilities


def list_leagues(connection: sqlite3.Connection) -> list[sqlite3.Row]:
    return connection.execute("SELECT id, name, country, season FROM leagues ORDER BY name").fetchall()


def list_teams(connection: sqlite3.Connection, league_id: int) -> list[sqlite3.Row]:
    return connection.execute(
        "SELECT id, name FROM teams WHERE league_id = ? ORDER BY name", (league_id,)
    ).fetchall()


def _row(connection: sqlite3.Connection, query: str, params: tuple) -> dict:
    found = connection.execute(query, params).fetchone()
    if found is None:
        raise ValueError("Not enough match data. Import results for both selected teams first.")
    return dict(found)


def _team_stats(connection: sqlite3.Connection, team_id: int) -> dict:
    return _row(
        connection,
        "SELECT * FROM team_season_stats WHERE team_id = ?",
        (team_id,),
    )


def _recent_stats(connection: sqlite3.Connection, team_id: int, window: int = 5) -> dict:
    return _row(
        connection,
        "SELECT * FROM team_recent_form_stats WHERE team_id = ? AND window_size = ?",
        (team_id, window),
    )


def _league_stats(connection: sqlite3.Connection, league_id: int) -> dict:
    return _row(
        connection,
        """
        SELECT COUNT(*) AS matches_played,
               AVG(home_goals + away_goals) AS avg_total_goals,
               AVG(home_goals) AS avg_home_goals,
               AVG(away_goals) AS avg_away_goals
        FROM matches WHERE league_id = ?
        """,
        (league_id,),
    )


def analyze_fixture(
    connection: sqlite3.Connection, league_id: int, home_team_id: int, away_team_id: int
) -> dict:
    home = _team_stats(connection, home_team_id)
    away = _team_stats(connection, away_team_id)
    recent_home = _recent_stats(connection, home_team_id)
    recent_away = _recent_stats(connection, away_team_id)
    league = _league_stats(connection, league_id)
    model = estimate_probabilities(home, away, league, recent_home, recent_away)
    return {
        "home": home,
        "away": away,
        "recent_home": recent_home,
        "recent_away": recent_away,
        "league": league,
        "model": asdict(model),
    }


def evaluate_odds(decimal_odds: float, model_probability: float) -> dict:
    if decimal_odds <= 1:
        raise ValueError("Decimal odds must be greater than 1.00.")
    implied = 1 / decimal_odds
    edge = model_probability - implied
    expected_value = decimal_odds * model_probability - 1
    return {
        "decimal_odds": decimal_odds,
        "implied_probability": implied,
        "model_probability": model_probability,
        "edge": edge,
        "expected_value": expected_value,
        "is_value": edge > 0,
    }


def save_value_calculation(
    db_path: str | Path,
    league_id: int,
    home_team_id: int,
    away_team_id: int,
    market: str,
    odds_result: dict,
    expected_total_goals: float,
    confidence: str,
) -> None:
    with database(db_path) as connection:
        cursor = connection.execute(
            """
            INSERT INTO odds_entries(
                league_id, home_team_id, away_team_id, market,
                decimal_odds, implied_probability
            ) VALUES (?, ?, ?, ?, ?, ?)
            """,
            (
                league_id,
                home_team_id,
                away_team_id,
                market,
                odds_result["decimal_odds"],
                odds_result["implied_probability"],
            ),
        )
        connection.execute(
            """
            INSERT INTO value_calculations(
                odds_entry_id, model_probability, edge, expected_value, is_value,
                confidence, expected_total_goals, model_version
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                cursor.lastrowid,
                odds_result["model_probability"],
                odds_result["edge"],
                odds_result["expected_value"],
                int(odds_result["is_value"]),
                confidence,
                expected_total_goals,
                MODEL_VERSION,
            ),
        )

