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
const ODDS_API_IO_EVENTS_CACHE_SECONDS = 900;
const ODDS_API_IO_ODDS_CACHE_SECONDS = 600;
const API_FOOTBALL_FIXTURES_CACHE_SECONDS = 900;
const API_FOOTBALL_ODDS_CACHE_SECONDS = 600;
const WORLD_CUP_ODDS_CACHE_SECONDS = 600;
const WORLD_CUP_VALUE_ODDS_CACHE_SECONDS = 172800;
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
  const snapshotDate = url.searchParams.get("snapshotDate");
  if (!fixtureDate || !homeTeam || !awayTeam) {
    return jsonResponse({ error: "Missing date, home or away fixture parameter." }, 400);
  }
  if (snapshotDate && !/^\d{4}-\d{2}-\d{2}$/.test(snapshotDate)) {
    return jsonResponse({ error: "Invalid snapshotDate parameter." }, 400);
  }
  const cacheScope = snapshotDate ? "world-cup-value-odds" : "world-cup-odds";
  const cacheParams = snapshotDate ? { fixtureDate, homeTeam, awayTeam, snapshotDate } : { fixtureDate, homeTeam, awayTeam };
  const responseCacheSeconds = snapshotDate ? WORLD_CUP_VALUE_ODDS_CACHE_SECONDS : WORLD_CUP_ODDS_CACHE_SECONDS;
  const cacheKey = new Request(cacheUrl(cacheScope, cacheParams));
  const cached = await caches.default.match(cacheKey);
  if (cached) return cached;

  const warnings = [];
  if (env.ODDS_API_IO_KEY) {
    try {
      const quotes = await fetchOddsApiIoFixtureOdds(env.ODDS_API_IO_KEY, fixtureDate, homeTeam, awayTeam);
      const response = jsonResponse(
        { quotes, best: bestQuotes(quotes), warnings },
        200,
        responseCacheSeconds,
      );
      await caches.default.put(cacheKey, response.clone());
      return response;
    } catch (error) {
      warnings.push(`Odds-API.io: ${error.message}`);
    }
  } else {
    warnings.push("Odds-API.io key is not configured.");
  }

  if (env.API_FOOTBALL_KEY) {
    try {
      const quotes = await fetchApiFootballFixtureOdds(env.API_FOOTBALL_KEY, fixtureDate, homeTeam, awayTeam);
      const response = jsonResponse(
        { quotes, best: bestQuotes(quotes), warnings },
        200,
        responseCacheSeconds,
      );
      await caches.default.put(cacheKey, response.clone());
      return response;
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
  const eventParams = {
    sport: "football",
    status: "pending,live",
    from: `${previousDay}T00:00:00Z`,
    to: `${nextDays}T00:00:00Z`,
  };
  const events = await cachedJson(
    cacheUrl("odds-api-io-events", eventParams),
    ODDS_API_IO_EVENTS_CACHE_SECONDS,
    () => oddsApiIoGet("events", apiKey, eventParams),
  );
  const fixture = findProviderFixture(events, homeTeam, awayTeam, "home", "away");
  const oddsParams = {
    eventId: fixture.id,
    bookmakers: ODDS_API_IO_BOOKMAKERS,
  };
  const payload = await cachedJson(
    cacheUrl("odds-api-io-odds", oddsParams),
    ODDS_API_IO_ODDS_CACHE_SECONDS,
    () => oddsApiIoGet("odds", apiKey, oddsParams),
  );
  const quotes = parseOddsApiIoQuotes(payload, fixtureDate, homeTeam, awayTeam);
  if (!quotes.length) throw new Error("fixture found but no Over 1.5 or Over 2.5 prices were returned.");
  return quotes;
}

async function fetchApiFootballFixtureOdds(apiKey, fixtureDate, homeTeam, awayTeam) {
  const fixtures = await fetchApiFootballFixtures(apiKey, fixtureDate);
  const fixture = findApiFootballFixture(fixtures.response || [], homeTeam, awayTeam);
  const fixtureId = Number(fixture.fixture.id);
  const prematchParams = { fixture: fixtureId, bet: GOALS_OVER_UNDER_BET_ID };
  const prematch = await cachedJson(
    cacheUrl("api-football-odds", prematchParams),
    API_FOOTBALL_ODDS_CACHE_SECONDS,
    () => apiFootballGet("odds", apiKey, prematchParams),
  );
  const prematchQuotes = parseApiFootballPrematchQuotes(prematch, fixtureId, fixtureDate, homeTeam, awayTeam);
  if (prematchQuotes.length) return prematchQuotes;
  const liveParams = { fixture: fixtureId };
  const live = await cachedJson(
    cacheUrl("api-football-live-odds", liveParams),
    60,
    () => apiFootballGet("odds/live", apiKey, liveParams),
  );
  const liveQuotes = parseApiFootballLiveQuotes(live, fixtureId, fixtureDate, homeTeam, awayTeam);
  if (liveQuotes.length) return liveQuotes;
  throw new Error("fixture found but no Over 1.5 or Over 2.5 prices were returned.");
}

async function fetchApiFootballFixtures(apiKey, fixtureDate) {
  const date = new Date(`${fixtureDate}T00:00:00Z`);
  const dates = [fixtureDate, offsetDate(date, 1), offsetDate(date, -1)];
  const responses = [];
  for (const item of dates) {
    const params = { date: item };
    responses.push(await cachedJson(
      cacheUrl("api-football-fixtures", params),
      API_FOOTBALL_FIXTURES_CACHE_SECONDS,
      () => apiFootballGet("fixtures", apiKey, params),
    ));
  }
  return { response: responses.flatMap((payload) => payload.response || []) };
}

async function oddsApiIoGet(endpoint, apiKey, params) {
  const url = new URL(`${ODDS_API_IO_BASE_URL}/${endpoint}`);
  url.searchParams.set("apiKey", apiKey);
  Object.entries(params).forEach(([key, value]) => url.searchParams.set(key, String(value)));
  const response = await fetch(url);
  if (!response.ok) throw new Error(await providerError(response));
  return response.json();
}

async function cachedJson(cacheKey, ttlSeconds, load) {
  const request = new Request(cacheKey);
  const cached = await caches.default.match(request);
  if (cached) return cached.json();
  const payload = await load();
  await caches.default.put(
    request,
    new Response(JSON.stringify(payload), {
      headers: {
        "Cache-Control": `public, max-age=${ttlSeconds}`,
        "Content-Type": "application/json; charset=utf-8",
      },
    }),
  );
  return payload;
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
  const targetHome = teamKeys(homeTeam);
  const targetAway = teamKeys(awayTeam);
  const fixture = events.find((event) => (
    intersects(teamKeys(event[homeKey] || ""), targetHome)
    && intersects(teamKeys(event[awayKey] || ""), targetAway)
  ));
  if (!fixture) throw new Error(`no published market for ${homeTeam} vs ${awayTeam} on this date.`);
  return fixture;
}

function findApiFootballFixture(events, homeTeam, awayTeam) {
  const targetHome = teamKeys(homeTeam);
  const targetAway = teamKeys(awayTeam);
  const fixture = events.find((event) => (
    intersects(teamKeys(event.teams?.home?.name || ""), targetHome)
    && intersects(teamKeys(event.teams?.away?.name || ""), targetAway)
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
  return name.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function teamKeys(name) {
  const keys = new Set([normalizedTeam(name)]);
  if (TEAM_ALIASES[name]) keys.add(normalizedTeam(TEAM_ALIASES[name]));
  Object.entries(TEAM_ALIASES)
    .filter(([, aliased]) => normalizedTeam(aliased) === normalizedTeam(name))
    .forEach(([original]) => keys.add(normalizedTeam(original)));
  return keys;
}

function intersects(first, second) {
  for (const key of first) {
    if (second.has(key)) return true;
  }
  return false;
}

function offsetDate(date, days) {
  const next = new Date(date);
  next.setUTCDate(next.getUTCDate() + days);
  return next.toISOString().slice(0, 10);
}

function cacheUrl(scope, params) {
  const url = new URL(`https://football-data-lab.internal/${scope}`);
  Object.entries(params)
    .sort(([first], [second]) => first.localeCompare(second))
    .forEach(([key, value]) => url.searchParams.set(key, String(value)));
  return url.toString();
}

function jsonResponse(payload, status = 200, maxAge = 0) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      "Cache-Control": maxAge > 0 ? `public, max-age=${maxAge}` : "no-store",
      "Content-Type": "application/json; charset=utf-8",
    },
  });
}
