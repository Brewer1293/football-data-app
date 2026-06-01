from __future__ import annotations

from dataclasses import dataclass
from math import exp

MODEL_VERSION = "poisson-v1"


@dataclass(frozen=True)
class ModelResult:
    expected_home_goals: float
    expected_away_goals: float
    expected_total_goals: float
    over_15_probability: float
    over_25_probability: float
    confidence: str


def _positive(value: float | None, fallback: float) -> float:
    return max(float(value), 0.05) if value is not None else fallback


def _poisson_over(total_lambda: float, threshold: int) -> float:
    """P(total goals > threshold) for a Poisson-distributed total."""
    cumulative = sum(
        exp(-total_lambda) * total_lambda**goals / _factorial(goals)
        for goals in range(threshold + 1)
    )
    return 1 - cumulative


def _factorial(number: int) -> int:
    result = 1
    for value in range(2, number + 1):
        result *= value
    return result


def estimate_probabilities(
    home: dict, away: dict, league: dict, home_recent: dict, away_recent: dict
) -> ModelResult:
    """Estimate fixture goals with explainable attack/defence strength factors.

    Season home/away splits lead the estimate. Recent goals and optional xG are
    small stabilizing adjustments so short runs influence rather than dominate.
    """
    league_home = _positive(league.get("avg_home_goals"), 1.4)
    league_away = _positive(league.get("avg_away_goals"), 1.1)

    home_attack = _positive(home.get("home_goals_scored"), league_home) / league_home
    away_defence = _positive(away.get("away_goals_conceded"), league_home) / league_home
    away_attack = _positive(away.get("away_goals_scored"), league_away) / league_away
    home_defence = _positive(home.get("home_goals_conceded"), league_away) / league_away

    expected_home = league_home * home_attack * away_defence
    expected_away = league_away * away_attack * home_defence

    season_total = max(float(home["goals_scored"]) + float(away["goals_scored"]), 0.1)
    recent_total = float(home_recent["goals_scored"]) + float(away_recent["goals_scored"])
    recent_factor = max(0.85, min(1.15, recent_total / season_total))
    expected_home *= 0.8 + 0.2 * recent_factor
    expected_away *= 0.8 + 0.2 * recent_factor

    if home.get("xg_for") is not None and away.get("xg_against") is not None:
        expected_home = 0.8 * expected_home + 0.2 * (
            float(home["xg_for"]) + float(away["xg_against"])
        ) / 2
    if away.get("xg_for") is not None and home.get("xg_against") is not None:
        expected_away = 0.8 * expected_away + 0.2 * (
            float(away["xg_for"]) + float(home["xg_against"])
        ) / 2

    total = max(0.1, min(expected_home + expected_away, 6.0))
    sample_size = min(int(home["matches_played"]), int(away["matches_played"]))
    has_xg = home.get("xg_for") is not None and away.get("xg_for") is not None
    confidence = "High" if sample_size >= 15 and has_xg else "Medium" if sample_size >= 8 else "Low"
    return ModelResult(
        expected_home_goals=expected_home,
        expected_away_goals=expected_away,
        expected_total_goals=total,
        over_15_probability=_poisson_over(total, 1),
        over_25_probability=_poisson_over(total, 2),
        confidence=confidence,
    )

