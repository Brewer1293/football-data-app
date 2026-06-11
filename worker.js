export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/api/world-cup-odds") {
      return fetchWorldCupOdds(url, env);
    }
    const sources = {
      "/data/world-cup-2026.txt": "https://raw.githubusercontent.com/openfootball/worldcup/master/2026--usa/cup.txt",
      "/data/international-results.csv": "https://raw.githubusercontent.com/martj42/international_results/master/results.csv",
    };
    if (sources[url.pathname]) {
      const cache = caches.default;
      const cacheKey = new Request(url.origin + url.pathname);
      const cached = await cache.match(cacheKey);
      if (cached) return cached;
      const upstream = await fetch(sources[url.pathname], { headers: { "User-Agent": "football-data-lab" } });
      if (!upstream.ok) return new Response("Public football dataset is temporarily unavailable", { status: 502 });
      const response = new Response(upstream.body, {
        headers: {
          "Cache-Control": "public, max-age=3600, s-maxage=86400",
          "Content-Type": url.pathname.endsWith(".csv") ? "text/csv; charset=utf-8" : "text/plain; charset=utf-8",
        },
      });
      await cache.put(cacheKey, response.clone());
      return response;
    }
    return env.ASSETS.fetch(request);
  },
};

const API_FOOTBALL_BASE_URL = "https://v3.football.api-sports.io";
const ODDS_API_IO_BASE_URL = "https://api.odds-api.io/v3";
const ODDS_API_IO_BOOKMAKERS = "Bet365";
const GOALS_OVER_UNDER_BET_ID = 5;
const MARKET_LINES = { "1.5": "over_1_5", "2.5": "over_2_5" };
const TEAM_ALIASES = {
  "Bosnia & Herzegovina": "Bosnia and Herzegovina",
  "Curaçao": "Curacao",
  "Czech Republic": "Czechia",
  "South Korea": "Korea Republic",
  Turkey: "Turkiye",
  USA: "United States",
};

async function fetchWorldCupOdds(url, env) {
  const fixtureDate = url.searchParams.get("date");
  const homeTeam = url.searchParams.get("home");
  const awayTeam = url.searchParams.get("away");
  if (!fixtureDate || !homeTeam || !awayTeam) {
    return jsonResponse({ error: "Missing date, home or away fixture parameter." }, 400);
  }

  const warnings = [];
  if (env.ODDS_API_IO_KEY) {
    try {
      const quotes = await fetchOddsApiIoFixtureOdds(env.ODDS_API_IO_KEY, fixtureDate, homeTeam, awayTeam);
      return jsonResponse({ quotes, best: bestQuotes(quotes), warnings });
    } catch (error) {
      warnings.push(`Odds-API.io: ${error.message}`);
    }
  } else {
    warnings.push("Odds-API.io key is not configured.");
  }

  if (env.API_FOOTBALL_KEY) {
    try {
      const quotes = await fetchApiFootballFixtureOdds(env.API_FOOTBALL_KEY, fixtureDate, homeTeam, awayTeam);
      return jsonResponse({ quotes, best: bestQuotes(quotes), warnings });
    } catch (error) {
      warnings.push(`API-Football: ${error.message}`);
    }
  } else {
    warnings.push("API-Football key is not configured.");
  }

  return jsonResponse({ error: warnings.join(" "), warnings }, 503);
}

async function fetchOddsApiIoFixtureOdds(apiKey, fixtureDate, homeTeam, awayTeam) {
  const date = new Date(`${fixtureDate}T00:00:00Z`);
  const previousDay = offsetDate(date, -1);
  const nextDays = offsetDate(date, 2);
  const events = await oddsApiIoGet("events", apiKey, {
    sport: "football",
    status: "pending,live",
    from: `${previousDay}T00:00:00Z`,
    to: `${nextDays}T00:00:00Z`,
  });
  const fixture = findProviderFixture(events, homeTeam, awayTeam, "home", "away");
  const payload = await oddsApiIoGet("odds", apiKey, {
    eventId: fixture.id,
    bookmakers: ODDS_API_IO_BOOKMAKERS,
  });
  const quotes = parseOddsApiIoQuotes(payload, fixtureDate, homeTeam, awayTeam);
  if (!quotes.length) throw new Error("fixture found but no Over 1.5 or Over 2.5 prices were returned.");
  return quotes;
}

async function fetchApiFootballFixtureOdds(apiKey, fixtureDate, homeTeam, awayTeam) {
  const fixtures = await apiFootballGet("fixtures", apiKey, { date: fixtureDate });
  const fixture = findApiFootballFixture(fixtures.response || [], homeTeam, awayTeam);
  const fixtureId = Number(fixture.fixture.id);
  const prematch = await apiFootballGet("odds", apiKey, { fixture: fixtureId, bet: GOALS_OVER_UNDER_BET_ID });
  const prematchQuotes = parseApiFootballPrematchQuotes(prematch, fixtureId, fixtureDate, homeTeam, awayTeam);
  if (prematchQuotes.length) return prematchQuotes;
  const live = await apiFootballGet("odds/live", apiKey, { fixture: fixtureId });
  const liveQuotes = parseApiFootballLiveQuotes(live, fixtureId, fixtureDate, homeTeam, awayTeam);
  if (liveQuotes.length) return liveQuotes;
  throw new Error("fixture found but no Over 1.5 or Over 2.5 prices were returned.");
}

async function oddsApiIoGet(endpoint, apiKey, params) {
  const url = new URL(`${ODDS_API_IO_BASE_URL}/${endpoint}`);
  url.searchParams.set("apiKey", apiKey);
  Object.entries(params).forEach(([key, value]) => url.searchParams.set(key, String(value)));
  const response = await fetch(url);
  if (!response.ok) throw new Error(await providerError(response));
  return response.json();
}

async function apiFootballGet(endpoint, apiKey, params) {
  const url = new URL(`${API_FOOTBALL_BASE_URL}/${endpoint}`);
  Object.entries(params).forEach(([key, value]) => url.searchParams.set(key, String(value)));
  const response = await fetch(url, { headers: { "x-apisports-key": apiKey } });
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${await response.text()}`);
  const payload = await response.json();
  if (payload.errors && Object.keys(payload.errors).length) {
    throw new Error(Object.values(payload.errors).join(" "));
  }
  return payload;
}

function findProviderFixture(events, homeTeam, awayTeam, homeKey, awayKey) {
  const targetHome = normalizedTeam(homeTeam);
  const targetAway = normalizedTeam(awayTeam);
  const fixture = events.find((event) => (
    normalizedTeam(event[homeKey] || "") === targetHome
    && normalizedTeam(event[awayKey] || "") === targetAway
  ));
  if (!fixture) throw new Error(`no published market for ${homeTeam} vs ${awayTeam} on this date.`);
  return fixture;
}

function findApiFootballFixture(events, homeTeam, awayTeam) {
  const targetHome = normalizedTeam(homeTeam);
  const targetAway = normalizedTeam(awayTeam);
  const fixture = events.find((event) => (
    normalizedTeam(event.teams?.home?.name || "") === targetHome
    && normalizedTeam(event.teams?.away?.name || "") === targetAway
  ));
  if (!fixture) throw new Error(`no matching fixture for ${homeTeam} vs ${awayTeam}.`);
  return fixture;
}

function parseOddsApiIoQuotes(payload, fixtureDate, homeTeam, awayTeam) {
  const quotes = [];
  Object.entries(payload.bookmakers || {}).forEach(([bookmaker, markets]) => {
    markets.forEach((market) => {
      if (!["Goals Over/Under", "Alternative Goal Line"].includes(market.name)) return;
      market.odds?.forEach((value) => {
        const appMarket = MARKET_LINES[String(value.hdp)];
        if (appMarket && value.over) {
          quotes.push(quote(payload.id, fixtureDate, homeTeam, awayTeam, bookmaker, appMarket, value.over, payload.status === "live", market.updatedAt, "odds-api.io"));
        }
      });
    });
  });
  return quotes;
}

function parseApiFootballPrematchQuotes(payload, fixtureId, fixtureDate, homeTeam, awayTeam) {
  const quotes = [];
  (payload.response || []).forEach((item) => {
    item.bookmakers?.forEach((bookmaker) => {
      bookmaker.bets?.forEach((bet) => {
        if (Number(bet.id) !== GOALS_OVER_UNDER_BET_ID) return;
        bet.values?.forEach((value) => {
          const match = String(value.value || "").match(/^Over\s+([12]\.5)$/i);
          const appMarket = match ? MARKET_LINES[match[1]] : null;
          if (appMarket) {
            quotes.push(quote(fixtureId, fixtureDate, homeTeam, awayTeam, bookmaker.name || "Unknown bookmaker", appMarket, value.odd, false, item.update, "api-football"));
          }
        });
      });
    });
  });
  return quotes;
}

function parseApiFootballLiveQuotes(payload, fixtureId, fixtureDate, homeTeam, awayTeam) {
  const quotes = [];
  (payload.response || []).forEach((item) => {
    item.odds?.forEach((bet) => {
      if (bet.name !== "Over/Under Line") return;
      bet.values?.forEach((value) => {
        const appMarket = !value.suspended && value.value === "Over" ? MARKET_LINES[String(value.handicap)] : null;
        if (appMarket) {
          quotes.push(quote(fixtureId, fixtureDate, homeTeam, awayTeam, "API-Football live consensus", appMarket, value.odd, true, item.update, "api-football"));
        }
      });
    });
  });
  return quotes;
}

function quote(providerFixtureId, fixtureDate, homeTeam, awayTeam, bookmaker, market, decimalOdds, isLive, providerUpdatedAt, provider) {
  return {
    providerFixtureId,
    fixtureDate,
    homeTeam,
    awayTeam,
    bookmaker,
    market,
    decimalOdds: Number(decimalOdds),
    isLive,
    providerUpdatedAt,
    provider,
  };
}

function bestQuotes(quotes) {
  return quotes.reduce((best, item) => {
    if (!best[item.market] || item.decimalOdds > best[item.market].decimalOdds) best[item.market] = item;
    return best;
  }, {});
}

async function providerError(response) {
  const body = await response.text();
  try {
    const payload = JSON.parse(body);
    return payload.error || body;
  } catch {
    return body || `HTTP ${response.status}`;
  }
}

function normalizedTeam(name) {
  const aliased = TEAM_ALIASES[name] || name;
  return aliased.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function offsetDate(date, days) {
  const next = new Date(date);
  next.setUTCDate(next.getUTCDate() + days);
  return next.toISOString().slice(0, 10);
}

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      "Cache-Control": "no-store",
      "Content-Type": "application/json; charset=utf-8",
    },
  });
}
