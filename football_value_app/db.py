from __future__ import annotations

import sqlite3
from contextlib import contextmanager
from pathlib import Path
from typing import Iterator

DEFAULT_DB_PATH = Path("data/football_value.db")


def connect(db_path: str | Path = DEFAULT_DB_PATH) -> sqlite3.Connection:
    path = Path(db_path)
    path.parent.mkdir(parents=True, exist_ok=True)
    connection = sqlite3.connect(path)
    connection.row_factory = sqlite3.Row
    connection.execute("PRAGMA foreign_keys = ON")
    return connection


@contextmanager
def database(db_path: str | Path = DEFAULT_DB_PATH) -> Iterator[sqlite3.Connection]:
    connection = connect(db_path)
    try:
        yield connection
        connection.commit()
    finally:
        connection.close()


def init_db(db_path: str | Path = DEFAULT_DB_PATH) -> None:
    with database(db_path) as connection:
        connection.executescript(
            """
            CREATE TABLE IF NOT EXISTS leagues (
                id INTEGER PRIMARY KEY,
                name TEXT NOT NULL,
                country TEXT NOT NULL,
                season TEXT NOT NULL,
                UNIQUE(name, season)
            );

            CREATE TABLE IF NOT EXISTS teams (
                id INTEGER PRIMARY KEY,
                league_id INTEGER NOT NULL REFERENCES leagues(id) ON DELETE CASCADE,
                name TEXT NOT NULL,
                UNIQUE(league_id, name)
            );

            CREATE TABLE IF NOT EXISTS matches (
                id INTEGER PRIMARY KEY,
                league_id INTEGER NOT NULL REFERENCES leagues(id) ON DELETE CASCADE,
                match_date TEXT NOT NULL,
                home_team_id INTEGER NOT NULL REFERENCES teams(id),
                away_team_id INTEGER NOT NULL REFERENCES teams(id),
                home_goals INTEGER NOT NULL CHECK(home_goals >= 0),
                away_goals INTEGER NOT NULL CHECK(away_goals >= 0),
                home_xg REAL,
                away_xg REAL,
                UNIQUE(league_id, match_date, home_team_id, away_team_id)
            );

            CREATE TABLE IF NOT EXISTS team_season_stats (
                team_id INTEGER PRIMARY KEY REFERENCES teams(id) ON DELETE CASCADE,
                matches_played INTEGER NOT NULL,
                home_matches INTEGER NOT NULL,
                away_matches INTEGER NOT NULL,
                goals_scored REAL NOT NULL,
                goals_conceded REAL NOT NULL,
                home_goals_scored REAL NOT NULL,
                home_goals_conceded REAL NOT NULL,
                away_goals_scored REAL NOT NULL,
                away_goals_conceded REAL NOT NULL,
                over_15_pct REAL NOT NULL,
                over_25_pct REAL NOT NULL,
                clean_sheet_pct REAL NOT NULL,
                failed_to_score_pct REAL NOT NULL,
                xg_for REAL,
                xg_against REAL,
                updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
            );

            CREATE TABLE IF NOT EXISTS team_recent_form_stats (
                team_id INTEGER NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
                window_size INTEGER NOT NULL CHECK(window_size IN (5, 10)),
                matches_played INTEGER NOT NULL,
                goals_scored REAL NOT NULL,
                goals_conceded REAL NOT NULL,
                over_15_pct REAL NOT NULL,
                over_25_pct REAL NOT NULL,
                clean_sheet_pct REAL NOT NULL,
                failed_to_score_pct REAL NOT NULL,
                xg_for REAL,
                xg_against REAL,
                updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                PRIMARY KEY(team_id, window_size)
            );

            CREATE TABLE IF NOT EXISTS odds_entries (
                id INTEGER PRIMARY KEY,
                league_id INTEGER NOT NULL REFERENCES leagues(id),
                home_team_id INTEGER NOT NULL REFERENCES teams(id),
                away_team_id INTEGER NOT NULL REFERENCES teams(id),
                market TEXT NOT NULL CHECK(market IN ('over_1_5', 'over_2_5')),
                decimal_odds REAL NOT NULL CHECK(decimal_odds > 1),
                implied_probability REAL NOT NULL,
                created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
            );

            CREATE TABLE IF NOT EXISTS value_calculations (
                id INTEGER PRIMARY KEY,
                odds_entry_id INTEGER NOT NULL REFERENCES odds_entries(id) ON DELETE CASCADE,
                model_probability REAL NOT NULL,
                edge REAL NOT NULL,
                expected_value REAL NOT NULL,
                is_value INTEGER NOT NULL CHECK(is_value IN (0, 1)),
                confidence TEXT NOT NULL,
                expected_total_goals REAL NOT NULL,
                model_version TEXT NOT NULL,
                created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
            );

            CREATE TABLE IF NOT EXISTS international_matches (
                id INTEGER PRIMARY KEY,
                match_date TEXT NOT NULL,
                home_team TEXT NOT NULL,
                away_team TEXT NOT NULL,
                home_goals INTEGER NOT NULL CHECK(home_goals >= 0),
                away_goals INTEGER NOT NULL CHECK(away_goals >= 0),
                tournament TEXT NOT NULL,
                city TEXT,
                country TEXT,
                neutral INTEGER NOT NULL CHECK(neutral IN (0, 1)),
                UNIQUE(match_date, home_team, away_team, tournament)
            );

            CREATE TABLE IF NOT EXISTS world_cup_fixtures (
                id INTEGER PRIMARY KEY,
                tournament_year INTEGER NOT NULL,
                group_name TEXT NOT NULL,
                match_date TEXT NOT NULL,
                home_team TEXT NOT NULL,
                away_team TEXT NOT NULL,
                venue TEXT NOT NULL,
                UNIQUE(tournament_year, group_name, match_date, home_team, away_team)
            );

            CREATE TABLE IF NOT EXISTS data_refresh_log (
                source TEXT PRIMARY KEY,
                refreshed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                row_count INTEGER NOT NULL
            );

            CREATE TABLE IF NOT EXISTS provider_odds_snapshots (
                id INTEGER PRIMARY KEY,
                provider TEXT NOT NULL,
                provider_fixture_id INTEGER NOT NULL,
                fixture_date TEXT NOT NULL,
                home_team TEXT NOT NULL,
                away_team TEXT NOT NULL,
                bookmaker TEXT NOT NULL,
                market TEXT NOT NULL CHECK(market IN ('over_1_5', 'over_2_5')),
                decimal_odds REAL NOT NULL CHECK(decimal_odds > 1),
                is_live INTEGER NOT NULL CHECK(is_live IN (0, 1)),
                provider_updated_at TEXT,
                fetched_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
            );

            CREATE INDEX IF NOT EXISTS idx_matches_league_date
                ON matches(league_id, match_date);
            CREATE INDEX IF NOT EXISTS idx_matches_home_team
                ON matches(home_team_id);
            CREATE INDEX IF NOT EXISTS idx_matches_away_team
                ON matches(away_team_id);
            CREATE INDEX IF NOT EXISTS idx_international_matches_date
                ON international_matches(match_date);
            CREATE INDEX IF NOT EXISTS idx_international_matches_home
                ON international_matches(home_team);
            CREATE INDEX IF NOT EXISTS idx_international_matches_away
                ON international_matches(away_team);
            CREATE INDEX IF NOT EXISTS idx_world_cup_fixtures_date
                ON world_cup_fixtures(tournament_year, match_date);
            CREATE INDEX IF NOT EXISTS idx_provider_odds_fixture
                ON provider_odds_snapshots(provider, provider_fixture_id, fetched_at);
            """
        )
