from __future__ import annotations

import json
import re
import sqlite3
import time
from dataclasses import dataclass
from datetime import date, timedelta
from pathlib import Path
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import Request, urlopen

from football_value_app.db import database, init_db

API_FOOTBALL_BASE_URL = "https://v3.football.api-sports.io"
ODDS_API_IO_BASE_URL = "https://api.odds-api.io/v3"
ODDS_API_IO_BOOKMAKERS = "Bet365"
ODDS_API_IO_EVENT_CACHE_TTL_SECONDS = 900
GOALS_OVER_UNDER_BET_ID = 5
MARKET_LINES = {"1.5": "over_1_5", "2.5": "over_2_5"}
TEAM_ALIASES = {
    "Bosnia & Herzegovina": "Bosnia and Herzegovina",
    "Curaçao": "Curacao",
    "Czech Republic": "Czechia",
    "South Korea": "Korea Republic",
    "Turkey": "Turkiye",
    "USA": "United States",
    "Man United": "Manchester United",
    "Man City": "Manchester City",
    "Nott'm Forest": "Nottingham Forest",
    "Tottenham": "Tottenham Hotspur",
}
_ODDS_API_IO_EVENT_CACHE: dict[tuple[str, date], tuple[float, list[dict[str, Any]]]] = {}


class OddsProviderError(RuntimeError):
    """Raised when API-Football cannot serve a usable odds response."""


class OddsAvailabilityError(OddsProviderError):
    """Raised when the provider account or market window cannot serve odds yet."""


@dataclass(frozen=True)
class OddsQuote:
    provider_fixture_id: int
    fixture_date: str
    home_team: str
    away_team: str
    bookmaker: str
    market: str
    decimal_odds: float
    is_live: bool
    provider_updated_at: str | None = None
    provider: str = "api-football"


def _api_get(endpoint: str, api_key: str, **params: object) -> dict[str, Any]:
    if not api_key.strip():
        raise OddsProviderError("Enter an API-Football key before fetching odds.")
    url = f"{API_FOOTBALL_BASE_URL}/{endpoint}"
    query = {key: value for key, value in params.items() if value is not None}
    if query:
        url = f"{url}?{urlencode(query)}"
    request = Request(url, headers={"x-apisports-key": api_key.strip()})
    try:
        with urlopen(request, timeout=20) as response:
            payload = json.loads(response.read().decode("utf-8"))
    except HTTPError as error:
        raise OddsProviderError(f"API-Football returned HTTP {error.code}.") from error
    except (URLError, TimeoutError, json.JSONDecodeError) as error:
        raise OddsProviderError(f"Could not reach API-Football: {error}") from error
    errors = payload.get("errors")
    if errors:
        message = _provider_error_message(errors)
        if "do not have access to this date" in message.lower():
            raise OddsAvailabilityError(
                f"{message} API-Football's free plan only exposes a short date window. "
                "Use manual odds for now, retry closer to kickoff, or upgrade the provider plan."
            )
        raise OddsProviderError(f"API-Football error: {message}")
    return payload


def _odds_api_io_get(endpoint: str, api_key: str, **params: object) -> Any:
    if not api_key.strip():
        raise OddsProviderError("Enter an Odds-API.io key before fetching future odds.")
    query = {"apiKey": api_key.strip()}
    query.update({key: value for key, value in params.items() if value is not None})
    url = f"{ODDS_API_IO_BASE_URL}/{endpoint}?{urlencode(query)}"
    try:
        with urlopen(url, timeout=20) as response:
            return json.loads(response.read().decode("utf-8"))
    except HTTPError as error:
        body = error.read().decode("utf-8", "replace")
        try:
            message = json.loads(body).get("error", body)
        except json.JSONDecodeError:
            message = body
        if error.code == 429:
            raise OddsAvailabilityError(
                f"Odds-API.io hourly request limit reached. {message} "
                "Manual odds entry remains available while the quota resets."
            ) from error
        raise OddsProviderError(f"Odds-API.io returned HTTP {error.code}: {message}") from error
    except (URLError, TimeoutError, json.JSONDecodeError) as error:
        raise OddsProviderError(f"Could not reach Odds-API.io: {error}") from error


def _provider_error_message(errors: object) -> str:
    if isinstance(errors, dict):
        return " ".join(str(value) for value in errors.values())
    if isinstance(errors, list):
        return " ".join(str(value) for value in errors)
    return str(errors)


def _normalized_team(name: str) -> str:
    aliased = TEAM_ALIASES.get(name, name)
    return re.sub(r"[^a-z0-9]", "", aliased.lower())


def find_fixture(
    api_key: str, fixture_date: date, home_team: str, away_team: str
) -> dict[str, Any]:
    """Match an app fixture to API-Football's provider fixture ID."""
    payload = _api_get("fixtures", api_key, date=fixture_date.isoformat())
    target_home = _normalized_team(home_team)
    target_away = _normalized_team(away_team)
    for item in payload.get("response", []):
        teams = item.get("teams", {})
        if (
            _normalized_team(teams.get("home", {}).get("name", "")) == target_home
            and _normalized_team(teams.get("away", {}).get("name", "")) == target_away
        ):
            return item
    raise OddsProviderError(
        f"API-Football has no matching fixture for {home_team} vs {away_team} on {fixture_date.isoformat()}."
    )


def fetch_fixture_odds(
    api_key: str, fixture_date: date, home_team: str, away_team: str
) -> list[OddsQuote]:
    """Fetch best available pre-match totals, falling back to in-play totals."""
    fixture = find_fixture(api_key, fixture_date, home_team, away_team)
    fixture_id = int(fixture["fixture"]["id"])
    prematch = _api_get("odds", api_key, fixture=fixture_id, bet=GOALS_OVER_UNDER_BET_ID)
    quotes = _parse_prematch_quotes(prematch, fixture_id, fixture_date, home_team, away_team)
    if quotes:
        return quotes
    live = _api_get("odds/live", api_key, fixture=fixture_id)
    quotes = _parse_live_quotes(live, fixture_id, fixture_date, home_team, away_team)
    if quotes:
        return quotes
    raise OddsProviderError("API-Football returned the fixture but no Over 1.5 or Over 2.5 prices.")


def fetch_odds_api_io_fixture_odds(
    api_key: str, fixture_date: date, home_team: str, away_team: str
) -> list[OddsQuote]:
    """Fetch published future or live totals from Odds-API.io."""
    # OpenFootball stores the host-city calendar date while Odds-API.io filters
    # by UTC timestamps. Include adjacent days for evening matches that cross
    # midnight UTC in North American host cities.
    previous_day = fixture_date - timedelta(days=1)
    next_days = fixture_date + timedelta(days=2)
    cache_key = (api_key.strip(), fixture_date)
    cached_at, events = _ODDS_API_IO_EVENT_CACHE.get(cache_key, (0.0, []))
    if time.monotonic() - cached_at > ODDS_API_IO_EVENT_CACHE_TTL_SECONDS:
        events = _odds_api_io_get(
            "events",
            api_key,
            sport="football",
            status="pending,live",
            **{
                "from": f"{previous_day.isoformat()}T00:00:00Z",
                "to": f"{next_days.isoformat()}T00:00:00Z",
            },
        )
        _ODDS_API_IO_EVENT_CACHE[cache_key] = (time.monotonic(), events)
    fixture = _find_odds_api_io_fixture(events, home_team, away_team)
    payload = _odds_api_io_get(
        "odds",
        api_key,
        eventId=fixture["id"],
        bookmakers=ODDS_API_IO_BOOKMAKERS,
    )
    quotes = _parse_odds_api_io_quotes(payload, fixture_date, home_team, away_team)
    if not quotes:
        raise OddsAvailabilityError(
            "Odds-API.io found the fixture but returned no Over 1.5 or Over 2.5 prices."
        )
    return quotes


def _find_odds_api_io_fixture(
    events: list[dict[str, Any]], home_team: str, away_team: str
) -> dict[str, Any]:
    target_home = _normalized_team(home_team)
    target_away = _normalized_team(away_team)
    for item in events:
        if (
            _normalized_team(item.get("home", "")) == target_home
            and _normalized_team(item.get("away", "")) == target_away
        ):
            return item
    raise OddsAvailabilityError(
        f"Odds-API.io has no published market for {home_team} vs {away_team} on this date."
    )


def _parse_odds_api_io_quotes(
    payload: dict[str, Any],
    fixture_date: date,
    home_team: str,
    away_team: str,
) -> list[OddsQuote]:
    quotes: list[OddsQuote] = []
    fixture_id = int(payload["id"])
    is_live = payload.get("status") == "live"
    for bookmaker, markets in payload.get("bookmakers", {}).items():
        for market in markets:
            if market.get("name") not in {"Goals Over/Under", "Alternative Goal Line"}:
                continue
            for value in market.get("odds", []):
                line = str(value.get("hdp"))
                app_market = MARKET_LINES.get(line)
                if app_market and value.get("over"):
                    quotes.append(
                        OddsQuote(
                            fixture_id,
                            fixture_date.isoformat(),
                            home_team,
                            away_team,
                            bookmaker,
                            app_market,
                            float(value["over"]),
                            is_live,
                            market.get("updatedAt"),
                            "odds-api.io",
                        )
                    )
    return quotes


def _parse_prematch_quotes(
    payload: dict[str, Any],
    fixture_id: int,
    fixture_date: date,
    home_team: str,
    away_team: str,
) -> list[OddsQuote]:
    quotes: list[OddsQuote] = []
    for item in payload.get("response", []):
        updated_at = item.get("update")
        for bookmaker in item.get("bookmakers", []):
            for bet in bookmaker.get("bets", []):
                if int(bet.get("id", 0)) != GOALS_OVER_UNDER_BET_ID:
                    continue
                for value in bet.get("values", []):
                    market = _prematch_market(value.get("value", ""))
                    if market:
                        quotes.append(
                            OddsQuote(
                                fixture_id,
                                fixture_date.isoformat(),
                                home_team,
                                away_team,
                                bookmaker.get("name", "Unknown bookmaker"),
                                market,
                                float(value["odd"]),
                                False,
                                updated_at,
                            )
                        )
    return quotes


def _prematch_market(value: str) -> str | None:
    match = re.match(r"^Over\s+([12]\.5)$", value.strip(), flags=re.IGNORECASE)
    return MARKET_LINES.get(match.group(1)) if match else None


def _parse_live_quotes(
    payload: dict[str, Any],
    fixture_id: int,
    fixture_date: date,
    home_team: str,
    away_team: str,
) -> list[OddsQuote]:
    quotes: list[OddsQuote] = []
    for item in payload.get("response", []):
        updated_at = item.get("update")
        for bet in item.get("odds", []):
            if bet.get("name") != "Over/Under Line":
                continue
            for value in bet.get("values", []):
                if value.get("suspended") or value.get("value") != "Over":
                    continue
                market = MARKET_LINES.get(str(value.get("handicap")))
                if market:
                    quotes.append(
                        OddsQuote(
                            fixture_id,
                            fixture_date.isoformat(),
                            home_team,
                            away_team,
                            "API-Football live consensus",
                            market,
                            float(value["odd"]),
                            True,
                            updated_at,
                        )
                    )
    return quotes


def best_quotes(quotes: list[OddsQuote]) -> dict[str, OddsQuote]:
    best: dict[str, OddsQuote] = {}
    for quote in quotes:
        current = best.get(quote.market)
        if current is None or quote.decimal_odds > current.decimal_odds:
            best[quote.market] = quote
    return best


def save_quotes(db_path: str | Path, quotes: list[OddsQuote]) -> int:
    init_db(db_path)
    with database(db_path) as connection:
        connection.executemany(
            """
            INSERT INTO provider_odds_snapshots(
                provider, provider_fixture_id, fixture_date, home_team, away_team,
                bookmaker, market, decimal_odds, is_live, provider_updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                (
                    quote.provider,
                    quote.provider_fixture_id,
                    quote.fixture_date,
                    quote.home_team,
                    quote.away_team,
                    quote.bookmaker,
                    quote.market,
                    quote.decimal_odds,
                    int(quote.is_live),
                    quote.provider_updated_at,
                )
                for quote in quotes
            ),
        )
    return len(quotes)


def latest_saved_quotes(
    connection: sqlite3.Connection, home_team: str, away_team: str
) -> list[sqlite3.Row]:
    return connection.execute(
        """
        SELECT bookmaker, market, decimal_odds, is_live, fetched_at
        FROM provider_odds_snapshots
        WHERE home_team = ? AND away_team = ?
        ORDER BY fetched_at DESC, decimal_odds DESC
        LIMIT 20
        """,
        (home_team, away_team),
    ).fetchall()
