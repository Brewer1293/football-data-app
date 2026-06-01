from __future__ import annotations

import sqlite3
from pathlib import Path
from typing import IO

import pandas as pd

from football_value_app.db import database, init_db
from football_value_app.stats import recalculate_stats

DATAHUB_EPL_URL = (
    "https://datahub.io/football/english-premier-league/_r/-/season-{season_code}.csv"
)
MATCH_COLUMNS = {
    "league",
    "country",
    "season",
    "date",
    "home_team",
    "away_team",
    "home_goals",
    "away_goals",
}
FOOTBALL_DATA_COLUMNS = {
    "date",
    "hometeam",
    "awayteam",
    "fthg",
    "ftag",
}
TEAM_STAT_COLUMNS = {
    "league",
    "country",
    "season",
    "team",
    "matches_played",
    "home_matches",
    "away_matches",
    "goals_scored",
    "goals_conceded",
    "home_goals_scored",
    "home_goals_conceded",
    "away_goals_scored",
    "away_goals_conceded",
    "over_15_pct",
    "over_25_pct",
    "clean_sheet_pct",
    "failed_to_score_pct",
}


def _read_csv(source: str | Path | IO[bytes]) -> pd.DataFrame:
    frame = pd.read_csv(source)
    frame.columns = [column.strip().lower() for column in frame.columns]
    return frame


def _normalize_match_frame(
    frame: pd.DataFrame,
    league: str | None,
    country: str | None,
    season: str | None,
) -> pd.DataFrame:
    """Translate common Football-Data CSV headers into the app's CSV contract."""
    if FOOTBALL_DATA_COLUMNS <= set(frame.columns):
        frame = frame.rename(
            columns={
                "hometeam": "home_team",
                "awayteam": "away_team",
                "fthg": "home_goals",
                "ftag": "away_goals",
            }
        )
    defaults = {"league": league, "country": country, "season": season}
    for column, value in defaults.items():
        if column not in frame.columns and value is not None:
            frame[column] = value
    return frame


def _get_or_create_league(
    connection: sqlite3.Connection, name: str, country: str, season: str
) -> int:
    connection.execute(
        "INSERT OR IGNORE INTO leagues(name, country, season) VALUES (?, ?, ?)",
        (name, country, season),
    )
    return int(
        connection.execute(
            "SELECT id FROM leagues WHERE name = ? AND season = ?", (name, season)
        ).fetchone()["id"]
    )


def _get_or_create_team(
    connection: sqlite3.Connection, league_id: int, name: str
) -> int:
    connection.execute(
        "INSERT OR IGNORE INTO teams(league_id, name) VALUES (?, ?)",
        (league_id, name),
    )
    return int(
        connection.execute(
            "SELECT id FROM teams WHERE league_id = ? AND name = ?", (league_id, name)
        ).fetchone()["id"]
    )


def import_matches_csv(
    source: str | Path | IO[bytes],
    db_path: str | Path,
    *,
    league: str | None = None,
    country: str | None = None,
    season: str | None = None,
) -> dict[str, int]:
    """Import result rows and refresh derived statistics.

    Native app CSVs carry league metadata in every row. Football-Data-style
    files use compact match headers, so callers provide the missing metadata.
    """
    init_db(db_path)
    frame = _normalize_match_frame(_read_csv(source), league, country, season)
    missing = MATCH_COLUMNS - set(frame.columns)
    if missing:
        raise ValueError(f"Match CSV is missing columns: {', '.join(sorted(missing))}")

    frame["date"] = pd.to_datetime(frame["date"], errors="raise").dt.date.astype(str)
    frame = frame.dropna(subset=["home_team", "away_team", "home_goals", "away_goals"])
    inserted = 0
    updated = 0
    with database(db_path) as connection:
        for row in frame.to_dict("records"):
            league_id = _get_or_create_league(
                connection, str(row["league"]).strip(), str(row["country"]).strip(), str(row["season"]).strip()
            )
            home_id = _get_or_create_team(connection, league_id, str(row["home_team"]).strip())
            away_id = _get_or_create_team(connection, league_id, str(row["away_team"]).strip())
            existing = connection.execute(
                """
                SELECT id FROM matches
                WHERE league_id = ? AND match_date = ? AND home_team_id = ? AND away_team_id = ?
                """,
                (league_id, row["date"], home_id, away_id),
            ).fetchone()
            values = (
                int(row["home_goals"]),
                int(row["away_goals"]),
                _optional_float(row.get("home_xg")),
                _optional_float(row.get("away_xg")),
            )
            if existing:
                connection.execute(
                    """
                    UPDATE matches
                    SET home_goals = ?, away_goals = ?, home_xg = ?, away_xg = ?
                    WHERE id = ?
                    """,
                    (*values, existing["id"]),
                )
                updated += 1
            else:
                connection.execute(
                    """
                    INSERT INTO matches(
                        league_id, match_date, home_team_id, away_team_id,
                        home_goals, away_goals, home_xg, away_xg
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    (league_id, row["date"], home_id, away_id, *values),
                )
                inserted += 1
        recalculate_stats(connection)
    return {"inserted": inserted, "updated": updated}


def import_datahub_epl_season(season_code: str, db_path: str | Path) -> dict[str, int]:
    """Import one EPL season from Datahub's stable Football-Data mirror URL."""
    if len(season_code) != 4 or not season_code.isdigit():
        raise ValueError("EPL season code must use four digits, for example 2526.")
    return import_matches_csv(
        DATAHUB_EPL_URL.format(season_code=season_code),
        db_path,
        league="Premier League",
        country="England",
        season=f"20{season_code[:2]}/{season_code[2:]}",
    )


def import_team_stats_csv(
    source: str | Path | IO[bytes], db_path: str | Path
) -> dict[str, int]:
    """Import optional externally calculated season stats.

    Percentages accept either decimals (0.72) or whole percentages (72).
    Match imports rebuild these rows, so apply an override after result imports.
    """
    init_db(db_path)
    frame = _read_csv(source)
    missing = TEAM_STAT_COLUMNS - set(frame.columns)
    if missing:
        raise ValueError(f"Team stats CSV is missing columns: {', '.join(sorted(missing))}")
    imported = 0
    with database(db_path) as connection:
        for row in frame.to_dict("records"):
            league_id = _get_or_create_league(
                connection, str(row["league"]).strip(), str(row["country"]).strip(), str(row["season"]).strip()
            )
            team_id = _get_or_create_team(connection, league_id, str(row["team"]).strip())
            connection.execute(
                """
                INSERT INTO team_season_stats(
                    team_id, matches_played, home_matches, away_matches, goals_scored,
                    goals_conceded, home_goals_scored, home_goals_conceded,
                    away_goals_scored, away_goals_conceded, over_15_pct, over_25_pct,
                    clean_sheet_pct, failed_to_score_pct, xg_for, xg_against
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(team_id) DO UPDATE SET
                    matches_played = excluded.matches_played,
                    home_matches = excluded.home_matches,
                    away_matches = excluded.away_matches,
                    goals_scored = excluded.goals_scored,
                    goals_conceded = excluded.goals_conceded,
                    home_goals_scored = excluded.home_goals_scored,
                    home_goals_conceded = excluded.home_goals_conceded,
                    away_goals_scored = excluded.away_goals_scored,
                    away_goals_conceded = excluded.away_goals_conceded,
                    over_15_pct = excluded.over_15_pct,
                    over_25_pct = excluded.over_25_pct,
                    clean_sheet_pct = excluded.clean_sheet_pct,
                    failed_to_score_pct = excluded.failed_to_score_pct,
                    xg_for = excluded.xg_for,
                    xg_against = excluded.xg_against,
                    updated_at = CURRENT_TIMESTAMP
                """,
                (
                    team_id,
                    int(row["matches_played"]),
                    int(row["home_matches"]),
                    int(row["away_matches"]),
                    float(row["goals_scored"]),
                    float(row["goals_conceded"]),
                    float(row["home_goals_scored"]),
                    float(row["home_goals_conceded"]),
                    float(row["away_goals_scored"]),
                    float(row["away_goals_conceded"]),
                    _percentage(row["over_15_pct"]),
                    _percentage(row["over_25_pct"]),
                    _percentage(row["clean_sheet_pct"]),
                    _percentage(row["failed_to_score_pct"]),
                    _optional_float(row.get("xg_for")),
                    _optional_float(row.get("xg_against")),
                ),
            )
            imported += 1
    return {"imported": imported}


def _optional_float(value: object) -> float | None:
    return None if value is None or pd.isna(value) or value == "" else float(value)


def _percentage(value: object) -> float:
    number = float(value)
    return number / 100 if number > 1 else number
