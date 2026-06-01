from __future__ import annotations

from contextlib import closing
from datetime import date
import os
from pathlib import Path

import pandas as pd
import streamlit as st

from football_value_app.db import DEFAULT_DB_PATH, connect, init_db
from football_value_app.importers import (
    import_datahub_epl_season,
    import_matches_csv,
    import_team_stats_csv,
)
from football_value_app.service import (
    analyze_fixture,
    evaluate_odds,
    list_leagues,
    list_teams,
    save_value_calculation,
)
from football_value_app.odds_provider import (
    OddsAvailabilityError,
    OddsProviderError,
    best_quotes,
    fetch_fixture_odds,
    fetch_odds_api_io_fixture_odds,
    save_quotes,
)
from football_value_app.worldcup import (
    analyze_world_cup_fixture,
    has_world_cup_data,
    latest_refresh,
    list_world_cup_fixtures,
    refresh_world_cup_data,
)

DB_PATH = Path(DEFAULT_DB_PATH)


def pct(value: float) -> str:
    return f"{value:.1%}"


def display_number(value: object) -> str:
    return "-" if value is None else f"{float(value):.2f}"


def stats_table(analysis: dict, home_name: str, away_name: str) -> pd.DataFrame:
    home, away = analysis["home"], analysis["away"]
    recent_home, recent_away = analysis["recent_home"], analysis["recent_away"]
    rows = [
        ("Season matches", str(home["matches_played"]), str(away["matches_played"])),
        ("Goals scored / game", display_number(home["goals_scored"]), display_number(away["goals_scored"])),
        ("Goals conceded / game", display_number(home["goals_conceded"]), display_number(away["goals_conceded"])),
        ("Home / away goals scored", display_number(home["home_goals_scored"]), display_number(away["away_goals_scored"])),
        ("Home / away goals conceded", display_number(home["home_goals_conceded"]), display_number(away["away_goals_conceded"])),
        ("Over 1.5 goals", pct(home["over_15_pct"]), pct(away["over_15_pct"])),
        ("Over 2.5 goals", pct(home["over_25_pct"]), pct(away["over_25_pct"])),
        ("Clean sheets", pct(home["clean_sheet_pct"]), pct(away["clean_sheet_pct"])),
        ("Failed to score", pct(home["failed_to_score_pct"]), pct(away["failed_to_score_pct"])),
        ("Last 5 goals scored / game", display_number(recent_home["goals_scored"]), display_number(recent_away["goals_scored"])),
        ("Last 5 Over 2.5 goals", pct(recent_home["over_25_pct"]), pct(recent_away["over_25_pct"])),
        ("xG for / game", display_number(home["xg_for"]), display_number(away["xg_for"])),
        ("xG against / game", display_number(home["xg_against"]), display_number(away["xg_against"])),
    ]
    return pd.DataFrame(rows, columns=["Metric", home_name, away_name]).set_index("Metric")


def render_market(
    market: str, label: str, odds: float, probability: float, context: dict
) -> None:
    result = evaluate_odds(odds, probability)
    st.subheader(label)
    cols = st.columns(4)
    cols[0].metric("Model probability", pct(probability))
    cols[1].metric("Implied probability", pct(result["implied_probability"]))
    cols[2].metric("Edge", pct(result["edge"]))
    cols[3].metric("Expected value", pct(result["expected_value"]))
    if result["is_value"]:
        st.success("Potential value bet: the model probability is above the bookmaker implied probability.")
    else:
        st.info("No modelled value at these odds.")
    if st.button(f"Save {label} calculation", key=f"save-{market}"):
        save_value_calculation(
            DB_PATH,
            context["league_id"],
            context["home_id"],
            context["away_id"],
            market,
            result,
            context["model"]["expected_total_goals"],
            context["model"]["confidence"],
        )
        st.toast("Calculation saved")


def api_football_key() -> str:
    return st.session_state.get("api_football_key", "") or os.getenv("API_FOOTBALL_KEY", "")


def odds_api_io_key() -> str:
    return st.session_state.get("odds_api_io_key", "") or os.getenv("ODDS_API_IO_KEY", "")


def render_api_football_settings() -> None:
    with st.sidebar:
        st.subheader("Live odds")
        st.text_input(
            "Odds-API.io key",
            type="password",
            key="odds_api_io_key",
            help="Primary source for published future odds. You can also set ODDS_API_IO_KEY before launching the app.",
        )
        st.text_input(
            "API-Football key",
            type="password",
            key="api_football_key",
            help="Stored only in this Streamlit session. You can also set API_FOOTBALL_KEY before launching the app.",
        )
        st.caption("Odds-API.io is tried first. API-Football is used as a fallback for nearby and in-play fixtures.")


def fetch_best_odds(fixture_date: date, home_team: str, away_team: str) -> dict:
    with st.spinner("Looking up fixture and fetching bookmaker odds..."):
        primary_error: OddsProviderError | None = None
        if odds_api_io_key():
            try:
                quotes = fetch_odds_api_io_fixture_odds(
                    odds_api_io_key(), fixture_date, home_team, away_team
                )
                save_quotes(DB_PATH, quotes)
                return best_quotes(quotes)
            except OddsProviderError as error:
                primary_error = error
        try:
            quotes = fetch_fixture_odds(api_football_key(), fixture_date, home_team, away_team)
        except OddsProviderError as error:
            if primary_error:
                raise OddsAvailabilityError(
                    f"Odds-API.io: {primary_error} API-Football fallback: {error}"
                ) from error
            raise
        save_quotes(DB_PATH, quotes)
    return best_quotes(quotes)


def fixture_quote_key(fixture_date: date, home_team: str, away_team: str) -> str:
    return f"{fixture_date.isoformat()}|{home_team}|{away_team}"


def render_imports() -> None:
    with st.sidebar:
        st.header("Import data")
        st.subheader("Quick load: EPL")
        epl_season = st.selectbox(
            "Datahub EPL season",
            ("2526", "2425", "2324", "2223", "2122", "2021", "1920"),
            format_func=lambda code: f"20{code[:2]}/20{code[2:]}",
        )
        if st.button("Load EPL season from Datahub"):
            try:
                with st.spinner("Downloading and importing EPL results..."):
                    result = import_datahub_epl_season(epl_season, DB_PATH)
                st.success(f"Imported {result['inserted']} new rows; updated {result['updated']}.")
                st.rerun()
            except Exception as error:
                st.error(f"Could not import Datahub EPL season: {error}")

        st.subheader("Upload CSV")
        match_file = st.file_uploader("Match results CSV", type="csv")
        with st.expander("Uploaded CSV defaults"):
            st.caption("Used only when a compact Football-Data CSV does not include these columns.")
            upload_league = st.text_input("League name", value="Premier League")
            upload_country = st.text_input("Country", value="England")
            upload_season = st.text_input("Season", value="2025/26")
        if st.button("Import match results", disabled=match_file is None):
            try:
                result = import_matches_csv(
                    match_file,
                    DB_PATH,
                    league=upload_league,
                    country=upload_country,
                    season=upload_season,
                )
                st.success(f"Imported {result['inserted']} new rows; updated {result['updated']}.")
                st.rerun()
            except ValueError as error:
                st.error(str(error))

        stats_file = st.file_uploader("Optional team stats CSV", type="csv")
        if st.button("Import team stat overrides", disabled=stats_file is None):
            try:
                result = import_team_stats_csv(stats_file, DB_PATH)
                st.success(f"Imported {result['imported']} team stat rows.")
                st.rerun()
            except ValueError as error:
                st.error(str(error))

        sample_path = Path("sample_data/demo_matches.csv")
        if sample_path.exists() and st.button("Load demo match data"):
            result = import_matches_csv(sample_path, DB_PATH)
            st.success(f"Loaded demo data: {result['inserted']} new rows.")
            st.rerun()


def render_league_analyser() -> None:
    with closing(connect(DB_PATH)) as connection:
        leagues = list_leagues(connection)
        if not leagues:
            st.info("Import a match-results CSV or load the demo data from the sidebar to begin.")
            return
        league_map = {f"{row['name']} ({row['season']})": row["id"] for row in leagues}
        league_label = st.selectbox("League", league_map)
        league_id = league_map[league_label]
        teams = list_teams(connection, league_id)
        team_map = {row["name"]: row["id"] for row in teams}
        columns = st.columns(2)
        home_name = columns[0].selectbox("Home team", team_map, index=0)
        away_options = [name for name in team_map if name != home_name]
        away_name = columns[1].selectbox("Away team", away_options, index=0)

        try:
            analysis = analyze_fixture(connection, league_id, team_map[home_name], team_map[away_name])
        except ValueError as error:
            st.warning(str(error))
            return

    model = analysis["model"]
    st.header(f"{home_name} vs {away_name}")
    summary = st.columns(4)
    summary[0].metric("Expected total goals", f"{model['expected_total_goals']:.2f}")
    summary[1].metric("Expected home goals", f"{model['expected_home_goals']:.2f}")
    summary[2].metric("Expected away goals", f"{model['expected_away_goals']:.2f}")
    summary[3].metric("Confidence", model["confidence"])

    st.subheader("Team comparison")
    st.dataframe(stats_table(analysis, home_name, away_name), width="stretch")
    league = analysis["league"]
    st.caption(
        f"League averages: {league['avg_total_goals']:.2f} total goals, "
        f"{league['avg_home_goals']:.2f} home goals and {league['avg_away_goals']:.2f} away goals per match."
    )

    st.header("Bookmaker comparison")
    with st.expander("Fetch bookmaker odds for a dated fixture"):
        odds_date = st.date_input("Fixture date", value=date.today(), key="league-odds-date")
        league_quote_key = fixture_quote_key(odds_date, home_name, away_name)
        if st.button("Fetch latest league odds", key="fetch-league-odds"):
            try:
                quotes = fetch_best_odds(odds_date, home_name, away_name)
                st.session_state["league_quotes"] = (league_quote_key, quotes)
                if quotes.get("over_1_5"):
                    st.session_state["league-odds-15"] = float(quotes["over_1_5"].decimal_odds)
                if quotes.get("over_2_5"):
                    st.session_state["league-odds-25"] = float(quotes["over_2_5"].decimal_odds)
            except OddsAvailabilityError as error:
                st.warning(str(error))
            except OddsProviderError as error:
                st.error(str(error))
        saved_quote_key, saved_quotes = st.session_state.get("league_quotes", ("", {}))
        league_quotes = saved_quotes if saved_quote_key == league_quote_key else {}
        for market, quote in league_quotes.items():
            st.caption(
                f"{market.replace('_', ' ').title()}: {quote.decimal_odds:.2f} "
                f"from {quote.bookmaker} via {quote.provider}{' (live)' if quote.is_live else ''}"
            )
    odds_columns = st.columns(2)
    odds_15 = odds_columns[0].number_input(
        "Decimal odds: Over 1.5", min_value=1.01,
        value=1.45,
        step=0.01,
        key="league-odds-15",
    )
    odds_25 = odds_columns[1].number_input(
        "Decimal odds: Over 2.5", min_value=1.01,
        value=2.10,
        step=0.01,
        key="league-odds-25",
    )
    render_market(
        "over_1_5", "Over 1.5 Goals", odds_15, model["over_15_probability"],
        {"league_id": league_id, "home_id": team_map[home_name], "away_id": team_map[away_name], "model": model},
    )
    render_market(
        "over_2_5", "Over 2.5 Goals", odds_25, model["over_25_probability"],
        {"league_id": league_id, "home_id": team_map[home_name], "away_id": team_map[away_name], "model": model},
    )

    with st.expander("How the V1 model works"):
        st.write(
            "The model estimates home and away scoring rates from each team's home/away "
            "attack and defence strength relative to league averages. It applies a limited "
            "recent-form adjustment and blends in xG when present, then uses a Poisson "
            "distribution for total-goal probabilities. Confidence reflects sample size and xG availability."
        )


def world_cup_stats_table(prediction: dict) -> pd.DataFrame:
    first, second = prediction["team_a"], prediction["team_b"]
    rows = [
        ("Recent matches used", str(first["matches"]), str(second["matches"])),
        ("Weighted goals scored / game", display_number(first["weighted_goals_for"]), display_number(second["weighted_goals_for"])),
        ("Weighted goals conceded / game", display_number(first["weighted_goals_against"]), display_number(second["weighted_goals_against"])),
        ("Over 1.5 goals", pct(first["over_15_pct"]), pct(second["over_15_pct"])),
        ("Over 2.5 goals", pct(first["over_25_pct"]), pct(second["over_25_pct"])),
        ("Clean sheets", pct(first["clean_sheet_pct"]), pct(second["clean_sheet_pct"])),
        ("Failed to score", pct(first["failed_to_score_pct"]), pct(second["failed_to_score_pct"])),
        ("Local Elo rating", str(round(first["elo"])), str(round(second["elo"]))),
    ]
    return pd.DataFrame(rows, columns=["Metric", first["team"], second["team"]]).set_index("Metric")


def render_world_cup_market(label: str, odds: float, probability: float) -> None:
    result = evaluate_odds(odds, probability)
    cols = st.columns(4)
    cols[0].metric(f"{label} model", pct(probability))
    cols[1].metric("Implied probability", pct(result["implied_probability"]))
    cols[2].metric("Edge", pct(result["edge"]))
    cols[3].metric("Expected value", pct(result["expected_value"]))
    if result["is_value"]:
        st.success(f"Potential value on {label} at {odds:.2f}.")
    else:
        st.info(f"No modelled value on {label} at {odds:.2f}.")


def render_world_cup_analyser() -> None:
    st.header("World Cup 2026 Predictor")
    st.caption(
        "Neutral-site fixture predictions from public international results and the OpenFootball USA 2026 schedule."
    )
    if st.button("Refresh World Cup public data"):
        try:
            with st.spinner("Downloading public international results and the 2026 schedule..."):
                result = refresh_world_cup_data(DB_PATH)
            st.success(
                f"Loaded {result['international_matches']:,} international matches "
                f"and {result['world_cup_group_fixtures']} World Cup group fixtures."
            )
            st.rerun()
        except Exception as error:
            st.error(f"Could not refresh World Cup datasets: {error}")
            return

    with closing(connect(DB_PATH)) as connection:
        if not has_world_cup_data(connection):
            st.info("Click **Refresh World Cup public data** to download the free datasets and begin.")
            return
        fixtures = list_world_cup_fixtures(connection)
        refresh_rows = latest_refresh(connection)
        fixture_map = {
            f"{row['match_date']} | Group {row['group_name']} | {row['home_team']} vs {row['away_team']}": row
            for row in fixtures
        }
        fixture_label = st.selectbox("Group-stage fixture", fixture_map)
        fixture = fixture_map[fixture_label]
        try:
            prediction = analyze_world_cup_fixture(
                connection, fixture["home_team"], fixture["away_team"]
            )
        except ValueError as error:
            st.warning(str(error))
            return

    st.subheader(f"{fixture['home_team']} vs {fixture['away_team']}")
    st.caption(f"Group {fixture['group_name']} | {fixture['match_date']} | {fixture['venue']}")
    summary = st.columns(4)
    summary[0].metric("Expected total goals", f"{prediction['expected_total_goals']:.2f}")
    summary[1].metric(f"{fixture['home_team']} win", pct(prediction["team_a_win_probability"]))
    summary[2].metric("Draw", pct(prediction["draw_probability"]))
    summary[3].metric(f"{fixture['away_team']} win", pct(prediction["team_b_win_probability"]))

    st.subheader("International team comparison")
    st.dataframe(world_cup_stats_table(prediction), width="stretch")
    st.caption(
        f"Expected goals: {fixture['home_team']} {prediction['expected_team_a_goals']:.2f}, "
        f"{fixture['away_team']} {prediction['expected_team_b_goals']:.2f}. "
        f"Model confidence: {prediction['confidence']}."
    )

    st.subheader("Goal-market odds comparison")
    st.caption(
        "Odds-API.io is tried first for published future World Cup prices. "
        "API-Football remains the fallback for nearby and in-play fixtures. "
        "Manual entry is always available below."
    )
    world_cup_quote_key = fixture_quote_key(
        date.fromisoformat(fixture["match_date"]), fixture["home_team"], fixture["away_team"]
    )
    if st.button("Fetch latest World Cup odds", key="fetch-world-cup-odds"):
        try:
            quotes = fetch_best_odds(
                date.fromisoformat(fixture["match_date"]),
                fixture["home_team"],
                fixture["away_team"],
            )
            st.session_state["world_cup_quotes"] = (world_cup_quote_key, quotes)
            if quotes.get("over_1_5"):
                st.session_state["world-cup-odds-15"] = float(quotes["over_1_5"].decimal_odds)
            if quotes.get("over_2_5"):
                st.session_state["world-cup-odds-25"] = float(quotes["over_2_5"].decimal_odds)
        except OddsAvailabilityError as error:
            st.warning(str(error))
        except OddsProviderError as error:
            st.error(str(error))
    saved_quote_key, saved_quotes = st.session_state.get("world_cup_quotes", ("", {}))
    world_cup_quotes = saved_quotes if saved_quote_key == world_cup_quote_key else {}
    for market, quote in world_cup_quotes.items():
        st.caption(
            f"{market.replace('_', ' ').title()}: {quote.decimal_odds:.2f} "
            f"from {quote.bookmaker} via {quote.provider}{' (live)' if quote.is_live else ''}"
        )
    odds_columns = st.columns(2)
    odds_15 = odds_columns[0].number_input(
        "World Cup decimal odds: Over 1.5", min_value=1.01,
        value=1.45,
        step=0.01,
        key="world-cup-odds-15",
    )
    odds_25 = odds_columns[1].number_input(
        "World Cup decimal odds: Over 2.5", min_value=1.01,
        value=2.10,
        step=0.01,
        key="world-cup-odds-25",
    )
    render_world_cup_market("Over 1.5 Goals", odds_15, prediction["over_15_probability"])
    render_world_cup_market("Over 2.5 Goals", odds_25, prediction["over_25_probability"])

    with st.expander("How the World Cup model works"):
        st.write(
            "This model is separate from the club-league model. It calculates local Elo-style "
            "team ratings from men's full internationals, uses each team's weighted last 20 "
            "matches, gives non-friendly matches slightly more weight, and applies a small host "
            "adjustment for Canada, Mexico, or USA. It then estimates neutral-site score and "
            "goal-market probabilities with Poisson distributions."
        )
        for row in refresh_rows:
            st.caption(f"{row['source']}: {row['row_count']:,} rows refreshed {row['refreshed_at']} UTC")


def main() -> None:
    st.set_page_config(page_title="Football Goal Market Value", layout="wide")
    init_db(DB_PATH)
    render_imports()
    render_api_football_settings()
    st.title("Football Goal Market Value Analysis")
    st.caption("Compare fixture goal probabilities with bookmaker decimal odds. This is an analysis tool, not betting advice.")
    league_tab, world_cup_tab = st.tabs(["League analyser", "World Cup 2026"])
    with league_tab:
        render_league_analyser()
    with world_cup_tab:
        render_world_cup_analyser()


if __name__ == "__main__":
    main()
