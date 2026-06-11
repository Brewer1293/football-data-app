from __future__ import annotations

import re
import sqlite3
from dataclasses import asdict, dataclass
from datetime import date, datetime
from io import StringIO
from math import exp
from pathlib import Path
from urllib.request import urlopen

import pandas as pd

from football_value_app.db import database, init_db
from football_value_app.model import _poisson_over

INTERNATIONAL_RESULTS_URL = (
    "https://raw.githubusercontent.com/martj42/international_results/master/results.csv"
)
WORLD_CUP_2026_URL = (
    "https://raw.githubusercontent.com/openfootball/worldcup/master/2026--usa/cup.txt"
)
MODEL_VERSION = "international-elo-poisson-v2"
HOST_TEAMS = {"Canada", "Mexico", "USA"}
FORM_SHRINK_MATCHES = 12
ATTACK_DEFENCE_FACTOR_MIN = 0.72
ATTACK_DEFENCE_FACTOR_MAX = 1.32
TOTAL_BASELINE_WEIGHT = 0.28
ELO_GOAL_SHARE_DIVISOR = 1400
HOST_GOAL_SHARE_BOOST = 1.04
TOTAL_GOALS_MIN = 1.35
TOTAL_GOALS_MAX = 3.35
TEAM_ALIASES = {
    "Bosnia & Herzegovina": "Bosnia and Herzegovina",
    "USA": "United States",
}
MONTHS = {
    "Jan": 1, "January": 1, "Feb": 2, "February": 2, "Mar": 3, "March": 3,
    "Apr": 4, "April": 4, "May": 5, "Jun": 6, "June": 6, "Jul": 7, "July": 7,
    "Aug": 8, "August": 8, "Sep": 9, "September": 9, "Oct": 10, "October": 10,
    "Nov": 11, "November": 11, "Dec": 12, "December": 12,
}
FIXTURE_RE = re.compile(
    r"^\s*\d{1,2}:\d{2}\s+UTC[+-]\d+\s+(.+?)\s+v\s+(.+?)\s+@\s+(.+?)\s*$"
)


@dataclass(frozen=True)
class InternationalTeamStats:
    team: str
    matches: int
    weighted_goals_for: float
    weighted_goals_against: float
    over_15_pct: float
    over_25_pct: float
    clean_sheet_pct: float
    failed_to_score_pct: float
    elo: float


@dataclass(frozen=True)
class WorldCupPrediction:
    team_a: InternationalTeamStats
    team_b: InternationalTeamStats
    expected_team_a_goals: float
    expected_team_b_goals: float
    expected_total_goals: float
    over_15_probability: float
    over_25_probability: float
    team_a_win_probability: float
    draw_probability: float
    team_b_win_probability: float
    confidence: str
    model_version: str = MODEL_VERSION


def _download_text(url: str) -> str:
    with urlopen(url, timeout=30) as response:
        return response.read().decode("utf-8-sig")


def refresh_world_cup_data(db_path: str | Path) -> dict[str, int]:
    """Download CC0 international results and the OpenFootball 2026 schedule."""
    init_db(db_path)
    results = pd.read_csv(StringIO(_download_text(INTERNATIONAL_RESULTS_URL)))
    results = results.dropna(subset=["date", "home_team", "away_team", "home_score", "away_score"])
    fixtures = parse_world_cup_2026_schedule(_download_text(WORLD_CUP_2026_URL))
    with database(db_path) as connection:
        connection.execute("DELETE FROM international_matches")
        connection.executemany(
            """
            INSERT OR IGNORE INTO international_matches(
                match_date, home_team, away_team, home_goals, away_goals,
                tournament, city, country, neutral
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                (
                    str(row.date),
                    str(row.home_team),
                    str(row.away_team),
                    int(row.home_score),
                    int(row.away_score),
                    str(row.tournament),
                    str(row.city),
                    str(row.country),
                    int(_as_bool(row.neutral)),
                )
                for row in results.itertuples(index=False)
            ),
        )
        connection.execute("DELETE FROM world_cup_fixtures WHERE tournament_year = 2026")
        connection.executemany(
            """
            INSERT INTO world_cup_fixtures(
                tournament_year, group_name, match_date, home_team, away_team, venue
            ) VALUES (2026, ?, ?, ?, ?, ?)
            """,
            fixtures,
        )
        stored_results = connection.execute(
            "SELECT COUNT(*) FROM international_matches"
        ).fetchone()[0]
        for source, count in (
            ("martj42/international_results", stored_results),
            ("openfootball/worldcup/2026--usa", len(fixtures)),
        ):
            connection.execute(
                """
                INSERT INTO data_refresh_log(source, row_count)
                VALUES (?, ?)
                ON CONFLICT(source) DO UPDATE SET
                    refreshed_at = CURRENT_TIMESTAMP, row_count = excluded.row_count
                """,
                (source, count),
            )
    return {"international_matches": stored_results, "world_cup_group_fixtures": len(fixtures)}


def _as_bool(value: object) -> bool:
    if isinstance(value, str):
        return value.strip().lower() in {"true", "1", "yes"}
    return bool(value)


def parse_world_cup_2026_schedule(text: str) -> list[tuple[str, str, str, str, str]]:
    fixtures: list[tuple[str, str, str, str, str]] = []
    group = ""
    current_date: date | None = None
    for raw_line in text.splitlines():
        line = raw_line.strip()
        group_match = re.match(r"^▪ Group ([A-L])$", line)
        if group_match:
            group = group_match.group(1)
            continue
        date_match = re.match(r"^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)\s+([A-Za-z]+)\s+(\d{1,2})$", line)
        if date_match:
            current_date = date(2026, MONTHS[date_match.group(1)], int(date_match.group(2)))
            continue
        fixture_match = FIXTURE_RE.match(line)
        if group and current_date and fixture_match:
            fixtures.append(
                (
                    group,
                    current_date.isoformat(),
                    fixture_match.group(1).strip(),
                    fixture_match.group(2).strip(),
                    fixture_match.group(3).strip(),
                )
            )
    if len(fixtures) != 72:
        raise ValueError(f"Expected 72 World Cup group fixtures but parsed {len(fixtures)}.")
    return fixtures


def has_world_cup_data(connection: sqlite3.Connection) -> bool:
    return bool(connection.execute("SELECT COUNT(*) FROM world_cup_fixtures").fetchone()[0])


def list_world_cup_fixtures(connection: sqlite3.Connection) -> list[sqlite3.Row]:
    return connection.execute(
        """
        SELECT id, group_name, match_date, home_team, away_team, venue
        FROM world_cup_fixtures WHERE tournament_year = 2026
        ORDER BY match_date, id
        """
    ).fetchall()


def _match_weight(match_date: str, tournament: str, as_of: date) -> float:
    days_old = max((as_of - date.fromisoformat(match_date)).days, 0)
    recency = exp(-days_old / 540)
    importance = 1.0 if tournament == "Friendly" else 1.15
    return recency * importance


def _elo_ratings(rows: list[sqlite3.Row]) -> dict[str, float]:
    ratings: dict[str, float] = {}
    for row in rows:
        home = row["home_team"]
        away = row["away_team"]
        home_rating = ratings.get(home, 1500.0)
        away_rating = ratings.get(away, 1500.0)
        venue_bonus = 0 if row["neutral"] else 60
        expected = 1 / (1 + 10 ** (-(home_rating + venue_bonus - away_rating) / 400))
        actual = 1.0 if row["home_goals"] > row["away_goals"] else 0.5 if row["home_goals"] == row["away_goals"] else 0.0
        importance = 20 if row["tournament"] == "Friendly" else 32
        margin = min(1.8, 1 + abs(row["home_goals"] - row["away_goals"]) * 0.12)
        change = importance * margin * (actual - expected)
        ratings[home] = home_rating + change
        ratings[away] = away_rating - change
    return ratings


def _team_stats(
    team: str, rows: list[sqlite3.Row], ratings: dict[str, float], as_of: date
) -> InternationalTeamStats:
    team_rows = [row for row in rows if row["home_team"] == team or row["away_team"] == team]
    recent = team_rows[-20:]
    if not recent:
        raise ValueError(f"No international results found for {team}.")
    values = []
    for row in recent:
        home = row["home_team"] == team
        goals_for = row["home_goals"] if home else row["away_goals"]
        goals_against = row["away_goals"] if home else row["home_goals"]
        values.append((goals_for, goals_against, _match_weight(row["match_date"], row["tournament"], as_of)))
    weight_total = sum(item[2] for item in values)
    weighted_for = sum(item[0] * item[2] for item in values) / weight_total
    weighted_against = sum(item[1] * item[2] for item in values) / weight_total
    return InternationalTeamStats(
        team=team,
        matches=len(recent),
        weighted_goals_for=weighted_for,
        weighted_goals_against=weighted_against,
        over_15_pct=sum(item[0] + item[1] > 1 for item in values) / len(values),
        over_25_pct=sum(item[0] + item[1] > 2 for item in values) / len(values),
        clean_sheet_pct=sum(item[1] == 0 for item in values) / len(values),
        failed_to_score_pct=sum(item[0] == 0 for item in values) / len(values),
        elo=ratings.get(team, 1500.0),
    )


def _score_probabilities(home_lambda: float, away_lambda: float) -> tuple[float, float, float]:
    home_win = draw = away_win = 0.0
    for home_goals in range(10):
        home_probability = exp(-home_lambda) * home_lambda**home_goals / _factorial(home_goals)
        for away_goals in range(10):
            probability = home_probability * exp(-away_lambda) * away_lambda**away_goals / _factorial(away_goals)
            if home_goals > away_goals:
                home_win += probability
            elif home_goals == away_goals:
                draw += probability
            else:
                away_win += probability
    return home_win, draw, away_win


def _factorial(number: int) -> int:
    result = 1
    for value in range(2, number + 1):
        result *= value
    return result


def _clamp(value: float, lower: float, upper: float) -> float:
    return max(lower, min(value, upper))


def _shrunk_rate(rate: float, baseline: float, matches: int) -> float:
    weight = matches / (matches + FORM_SHRINK_MATCHES)
    return baseline + (rate - baseline) * weight


def _rate_factor(rate: float, baseline: float, matches: int) -> float:
    shrunk = _shrunk_rate(rate, baseline, matches)
    return _clamp(
        shrunk / baseline,
        ATTACK_DEFENCE_FACTOR_MIN,
        ATTACK_DEFENCE_FACTOR_MAX,
    )


def _expected_world_cup_goals(
    first: InternationalTeamStats,
    second: InternationalTeamStats,
    baseline: float,
    team_a: str,
    team_b: str,
) -> tuple[float, float]:
    first_attack = _rate_factor(first.weighted_goals_for, baseline, first.matches)
    first_defence = _rate_factor(first.weighted_goals_against, baseline, first.matches)
    second_attack = _rate_factor(second.weighted_goals_for, baseline, second.matches)
    second_defence = _rate_factor(second.weighted_goals_against, baseline, second.matches)
    raw_first = baseline * first_attack * second_defence
    raw_second = baseline * second_attack * first_defence
    if team_a in HOST_TEAMS:
        raw_first *= HOST_GOAL_SHARE_BOOST
    if team_b in HOST_TEAMS:
        raw_second *= HOST_GOAL_SHARE_BOOST
    raw_total = raw_first + raw_second
    total = raw_total * (1 - TOTAL_BASELINE_WEIGHT) + baseline * 2 * TOTAL_BASELINE_WEIGHT
    total = _clamp(total, TOTAL_GOALS_MIN, TOTAL_GOALS_MAX)
    elo_factor = exp((first.elo - second.elo) / ELO_GOAL_SHARE_DIVISOR)
    share_first = (raw_first * elo_factor) / (raw_first * elo_factor + raw_second)
    expected_first = _clamp(total * share_first, 0.15, 3.2)
    expected_second = _clamp(total - expected_first, 0.15, 3.2)
    return expected_first, expected_second


def analyze_world_cup_fixture(
    connection: sqlite3.Connection, team_a: str, team_b: str, as_of: date | None = None
) -> dict:
    """Predict a 2026 fixture from recent full internationals and local Elo ratings."""
    cutoff = as_of or date.today()
    rows = connection.execute(
        """
        SELECT match_date, home_team, away_team, home_goals, away_goals, tournament, neutral
        FROM international_matches WHERE match_date < ? ORDER BY match_date, id
        """,
        (cutoff.isoformat(),),
    ).fetchall()
    if not rows:
        raise ValueError("Refresh the World Cup public datasets before running predictions.")
    ratings = _elo_ratings(rows)
    first = _team_stats(TEAM_ALIASES.get(team_a, team_a), rows, ratings, cutoff)
    second = _team_stats(TEAM_ALIASES.get(team_b, team_b), rows, ratings, cutoff)
    international_average = sum(row["home_goals"] + row["away_goals"] for row in rows[-5000:]) / min(len(rows), 5000)
    baseline = international_average / 2
    expected_first, expected_second = _expected_world_cup_goals(
        first, second, baseline, team_a, team_b
    )
    total = expected_first + expected_second
    first_win, draw, second_win = _score_probabilities(expected_first, expected_second)
    prediction = WorldCupPrediction(
        team_a=first,
        team_b=second,
        expected_team_a_goals=expected_first,
        expected_team_b_goals=expected_second,
        expected_total_goals=total,
        over_15_probability=_poisson_over(total, 1),
        over_25_probability=_poisson_over(total, 2),
        team_a_win_probability=first_win,
        draw_probability=draw,
        team_b_win_probability=second_win,
        confidence="Medium" if min(first.matches, second.matches) >= 15 else "Low",
    )
    return asdict(prediction)


def latest_refresh(connection: sqlite3.Connection) -> list[sqlite3.Row]:
    return connection.execute(
        "SELECT source, refreshed_at, row_count FROM data_refresh_log ORDER BY source"
    ).fetchall()
