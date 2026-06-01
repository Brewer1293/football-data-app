from __future__ import annotations

import sqlite3

import pandas as pd


def _matches_frame(connection: sqlite3.Connection) -> pd.DataFrame:
    return pd.read_sql_query(
        """
        SELECT id, league_id, match_date, home_team_id, away_team_id,
               home_goals, away_goals, home_xg, away_xg
        FROM matches
        ORDER BY match_date, id
        """,
        connection,
    )


def _team_match_rows(matches: pd.DataFrame) -> pd.DataFrame:
    if matches.empty:
        return pd.DataFrame()
    home = pd.DataFrame(
        {
            "team_id": matches["home_team_id"],
            "match_date": matches["match_date"],
            "venue": "home",
            "goals_for": matches["home_goals"],
            "goals_against": matches["away_goals"],
            "xg_for": matches["home_xg"],
            "xg_against": matches["away_xg"],
        }
    )
    away = pd.DataFrame(
        {
            "team_id": matches["away_team_id"],
            "match_date": matches["match_date"],
            "venue": "away",
            "goals_for": matches["away_goals"],
            "goals_against": matches["home_goals"],
            "xg_for": matches["away_xg"],
            "xg_against": matches["home_xg"],
        }
    )
    rows = pd.concat([home, away], ignore_index=True)
    rows["total_goals"] = rows["goals_for"] + rows["goals_against"]
    return rows.sort_values(["team_id", "match_date"])


def _mean_or_zero(rows: pd.DataFrame, column: str) -> float:
    return float(rows[column].mean()) if not rows.empty else 0.0


def _nullable_mean(rows: pd.DataFrame, column: str) -> float | None:
    value = rows[column].mean() if not rows.empty else None
    return None if value is None or pd.isna(value) else float(value)


def _summary(team_id: int, rows: pd.DataFrame) -> tuple:
    home = rows[rows["venue"] == "home"]
    away = rows[rows["venue"] == "away"]
    return (
        team_id,
        len(rows),
        len(home),
        len(away),
        _mean_or_zero(rows, "goals_for"),
        _mean_or_zero(rows, "goals_against"),
        _mean_or_zero(home, "goals_for"),
        _mean_or_zero(home, "goals_against"),
        _mean_or_zero(away, "goals_for"),
        _mean_or_zero(away, "goals_against"),
        float((rows["total_goals"] > 1).mean()),
        float((rows["total_goals"] > 2).mean()),
        float((rows["goals_against"] == 0).mean()),
        float((rows["goals_for"] == 0).mean()),
        _nullable_mean(rows, "xg_for"),
        _nullable_mean(rows, "xg_against"),
    )


def _recent_summary(team_id: int, window: int, rows: pd.DataFrame) -> tuple:
    recent = rows.tail(window)
    return (
        team_id,
        window,
        len(recent),
        _mean_or_zero(recent, "goals_for"),
        _mean_or_zero(recent, "goals_against"),
        float((recent["total_goals"] > 1).mean()),
        float((recent["total_goals"] > 2).mean()),
        float((recent["goals_against"] == 0).mean()),
        float((recent["goals_for"] == 0).mean()),
        _nullable_mean(recent, "xg_for"),
        _nullable_mean(recent, "xg_against"),
    )


def recalculate_stats(connection: sqlite3.Connection) -> None:
    """Rebuild cached stats from match results after an import."""
    connection.execute("DELETE FROM team_season_stats")
    connection.execute("DELETE FROM team_recent_form_stats")
    rows = _team_match_rows(_matches_frame(connection))
    if rows.empty:
        return
    for team_id, team_rows in rows.groupby("team_id"):
        connection.execute(
            """
            INSERT INTO team_season_stats(
                team_id, matches_played, home_matches, away_matches, goals_scored,
                goals_conceded, home_goals_scored, home_goals_conceded,
                away_goals_scored, away_goals_conceded, over_15_pct, over_25_pct,
                clean_sheet_pct, failed_to_score_pct, xg_for, xg_against
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            _summary(int(team_id), team_rows),
        )
        for window in (5, 10):
            connection.execute(
                """
                INSERT INTO team_recent_form_stats(
                    team_id, window_size, matches_played, goals_scored, goals_conceded,
                    over_15_pct, over_25_pct, clean_sheet_pct, failed_to_score_pct,
                    xg_for, xg_against
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                _recent_summary(int(team_id), window, team_rows),
            )
