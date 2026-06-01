from football_value_app.model import estimate_probabilities
from football_value_app.service import evaluate_odds


def test_poisson_model_returns_ordered_goal_market_probabilities():
    home = {
        "matches_played": 20,
        "goals_scored": 1.8,
        "home_goals_scored": 2.0,
        "home_goals_conceded": 1.1,
        "xg_for": 1.9,
        "xg_against": 1.0,
    }
    away = {
        "matches_played": 20,
        "goals_scored": 1.5,
        "away_goals_scored": 1.4,
        "away_goals_conceded": 1.6,
        "xg_for": 1.5,
        "xg_against": 1.5,
    }
    recent = {"goals_scored": 1.7}
    result = estimate_probabilities(
        home, away, {"avg_home_goals": 1.5, "avg_away_goals": 1.2}, recent, recent
    )
    assert 0 < result.over_25_probability < result.over_15_probability < 1
    assert result.expected_total_goals > 0
    assert result.confidence == "High"


def test_odds_evaluation_calculates_edge_and_expected_value():
    result = evaluate_odds(2.10, 0.58)
    assert round(result["implied_probability"], 4) == 0.4762
    assert round(result["edge"], 4) == 0.1038
    assert round(result["expected_value"], 3) == 0.218
    assert result["is_value"] is True

