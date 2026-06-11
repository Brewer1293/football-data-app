const byId = (id) => document.querySelector(`#${id}`);
const pct = (value) => `${(value * 100).toFixed(1)}%`;
const num = (value) => Number(value).toFixed(2);
const factorial = (n) => Array.from({ length: n }, (_, index) => index + 1).reduce((value, part) => value * part, 1);
const poisson = (lambda, goals) => Math.exp(-lambda) * lambda ** goals / factorial(goals);
const poissonOver = (lambda, threshold) => 1 - Array.from({ length: threshold + 1 }, (_, goals) => poisson(lambda, goals)).reduce((sum, value) => sum + value, 0);
const positive = (value, fallback) => Math.max(Number(value ?? fallback), 0.05);
const average = (rows, key) => rows.reduce((total, row) => total + row[key], 0) / rows.length;
const metric = (label, value, note) => `<article class="metric"><span>${label}</span><strong>${value}</strong><small>${note}</small></article>`;
const comparisonRow = (label, first, second) => `<tr><td>${label}</td><td>${first}</td><td>${second}</td></tr>`;
const oddsResult = (odds, probability) => {
  const implied = 1 / odds;
  return { implied, edge: probability - implied, ev: odds * probability - 1, value: probability > implied };
};
const addDays = (date, days) => { const next = new Date(date); next.setDate(next.getDate() + days); return next; };
const localIsoDate = (date = new Date()) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
const market = (label, probability, odds) => {
  const result = oddsResult(odds, probability);
  return `<article class="market-card"><div class="market-head"><h3>${label}</h3><span class="value-chip ${result.value ? "" : "no-value"}">${result.value ? "Potential value" : "No model edge"}</span></div><div class="market-stats"><div><span>Model probability</span><strong>${pct(probability)}</strong></div><div><span>Implied probability</span><strong>${pct(result.implied)}</strong></div><div><span>Expected value</span><strong>${pct(result.ev)}</strong></div></div></article>`;
};

let matches = [];
let teams = [];
let worldCupFixtures = [];
let internationalRows = [];
let worldCupReady = false;

function parseCsv(text) {
  const rows = [];
  let row = [], value = "", quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index], next = text[index + 1];
    if (char === '"' && quoted && next === '"') { value += '"'; index += 1; }
    else if (char === '"') quoted = !quoted;
    else if (char === "," && !quoted) { row.push(value); value = ""; }
    else if ((char === "\n" || char === "\r") && !quoted) {
      if (char === "\r" && next === "\n") index += 1;
      row.push(value); value = "";
      if (row.some(Boolean)) rows.push(row);
      row = [];
    } else value += char;
  }
  if (value || row.length) { row.push(value); rows.push(row); }
  const [header, ...values] = rows;
  return values.map((parts) => Object.fromEntries(header.map((key, index) => [key.trim(), parts[index] ?? ""])));
}

function teamRows(team) {
  return matches.filter((match) => match.home_team === team || match.away_team === team).map((match) => {
    const home = match.home_team === team;
    return { venue: home ? "home" : "away", goalsFor: Number(home ? match.home_goals : match.away_goals), goalsAgainst: Number(home ? match.away_goals : match.home_goals), xgFor: Number(home ? match.home_xg : match.away_xg), xgAgainst: Number(home ? match.away_xg : match.home_xg), date: match.date };
  }).sort((a, b) => a.date.localeCompare(b.date));
}

function summarize(team) {
  const rows = teamRows(team), home = rows.filter((row) => row.venue === "home"), away = rows.filter((row) => row.venue === "away");
  const totalGoals = (row) => row.goalsFor + row.goalsAgainst;
  return { matchesPlayed: rows.length, goalsScored: average(rows, "goalsFor"), goalsConceded: average(rows, "goalsAgainst"), homeGoalsScored: average(home, "goalsFor"), homeGoalsConceded: average(home, "goalsAgainst"), awayGoalsScored: average(away, "goalsFor"), awayGoalsConceded: average(away, "goalsAgainst"), over15: rows.filter((row) => totalGoals(row) > 1).length / rows.length, over25: rows.filter((row) => totalGoals(row) > 2).length / rows.length, xgFor: average(rows, "xgFor"), xgAgainst: average(rows, "xgAgainst") };
}

function recent(team) {
  const rows = teamRows(team).slice(-5);
  return { goalsScored: average(rows, "goalsFor") };
}

function leagueStats() {
  return { avgHome: average(matches.map((match) => ({ value: Number(match.home_goals) })), "value"), avgAway: average(matches.map((match) => ({ value: Number(match.away_goals) })), "value") };
}

function leagueModel(home, away, homeRecent, awayRecent, league) {
  let expectedHome = positive(league.avgHome, 1.4) * (positive(home.homeGoalsScored, league.avgHome) / league.avgHome) * (positive(away.awayGoalsConceded, league.avgHome) / league.avgHome);
  let expectedAway = positive(league.avgAway, 1.1) * (positive(away.awayGoalsScored, league.avgAway) / league.avgAway) * (positive(home.homeGoalsConceded, league.avgAway) / league.avgAway);
  const recentFactor = Math.max(.85, Math.min(1.15, (homeRecent.goalsScored + awayRecent.goalsScored) / Math.max(home.goalsScored + away.goalsScored, .1)));
  expectedHome *= .8 + .2 * recentFactor; expectedAway *= .8 + .2 * recentFactor;
  expectedHome = .8 * expectedHome + .2 * (home.xgFor + away.xgAgainst) / 2;
  expectedAway = .8 * expectedAway + .2 * (away.xgFor + home.xgAgainst) / 2;
  const total = Math.max(.1, Math.min(expectedHome + expectedAway, 6));
  return { expectedHome, expectedAway, total, over15: poissonOver(total, 1), over25: poissonOver(total, 2), confidence: Math.min(home.matchesPlayed, away.matchesPlayed) >= 8 ? "Medium confidence" : "Low confidence" };
}

function analyzeLeague() {
  const homeName = byId("home-team").value, awayName = byId("away-team").value;
  const home = summarize(homeName), away = summarize(awayName), league = leagueStats(), result = leagueModel(home, away, recent(homeName), recent(awayName), league);
  byId("fixture-title").textContent = `${homeName} vs ${awayName}`; byId("fixture-subtitle").textContent = "Premier League demo analysis"; byId("confidence").textContent = result.confidence;
  byId("metrics").innerHTML = metric("Expected total goals", num(result.total), "Poisson total") + metric("Expected home goals", num(result.expectedHome), homeName) + metric("Expected away goals", num(result.expectedAway), awayName);
  byId("markets").innerHTML = market("Over 1.5 Goals", result.over15, Number(byId("odds-15").value)) + market("Over 2.5 Goals", result.over25, Number(byId("odds-25").value));
  byId("home-heading").textContent = homeName; byId("away-heading").textContent = awayName; byId("league-summary").textContent = `League average: ${num(league.avgHome + league.avgAway)} goals`;
  byId("comparison-body").innerHTML = comparisonRow("Season matches", home.matchesPlayed, away.matchesPlayed) + comparisonRow("Goals scored / game", num(home.goalsScored), num(away.goalsScored)) + comparisonRow("Goals conceded / game", num(home.goalsConceded), num(away.goalsConceded)) + comparisonRow("Home / away goals scored", num(home.homeGoalsScored), num(away.awayGoalsScored)) + comparisonRow("Over 1.5 goals", pct(home.over15), pct(away.over15)) + comparisonRow("Over 2.5 goals", pct(home.over25), pct(away.over25)) + comparisonRow("xG for / game", num(home.xgFor), num(away.xgFor));
}

function fillTeams() {
  const options = teams.map((team) => `<option>${team}</option>`).join("");
  byId("home-team").innerHTML = options; byId("away-team").innerHTML = options; byId("away-team").selectedIndex = 1;
}

const months = { Jan:1, January:1, Feb:2, February:2, Mar:3, March:3, Apr:4, April:4, May:5, Jun:6, June:6, Jul:7, July:7 };
function parseWorldCupSchedule(text) {
  const fixtures = [];
  let group = "", date = "";
  text.split(/\r?\n/).forEach((raw) => {
    const line = raw.trim();
    const groupMatch = line.match(/^▪ Group ([A-L])$/);
    if (groupMatch) { group = groupMatch[1]; return; }
    const dateMatch = line.match(/^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)\s+([A-Za-z]+)\s+(\d{1,2})$/);
    if (dateMatch) { date = `2026-${String(months[dateMatch[1]]).padStart(2, "0")}-${String(dateMatch[2]).padStart(2, "0")}`; return; }
    const fixture = line.match(/^\d{1,2}:\d{2}\s+UTC[+-]\d+\s+(.+?)\s+v\s+(.+?)\s+@\s+(.+?)\s*$/);
    if (group && date && fixture) fixtures.push({ group, date, home: fixture[1].trim(), away: fixture[2].trim(), venue: fixture[3].trim() });
  });
  if (fixtures.length !== 72) throw new Error(`Expected 72 World Cup group fixtures but received ${fixtures.length}.`);
  return fixtures;
}

const aliases = { "Bosnia & Herzegovina":"Bosnia and Herzegovina", USA:"United States" };
const hosts = new Set(["Canada", "Mexico", "USA"]);
function scoreProbabilities(firstLambda, secondLambda) {
  let firstWin = 0, draw = 0, secondWin = 0;
  for (let first = 0; first < 10; first += 1) for (let second = 0; second < 10; second += 1) {
    const probability = poisson(firstLambda, first) * poisson(secondLambda, second);
    if (first > second) firstWin += probability; else if (first === second) draw += probability; else secondWin += probability;
  }
  return { firstWin, draw, secondWin };
}

function eloRatings(rows) {
  const ratings = new Map();
  rows.forEach((row) => {
    const homeRating = ratings.get(row.home) || 1500, awayRating = ratings.get(row.away) || 1500;
    const expected = 1 / (1 + 10 ** (-(homeRating + (row.neutral ? 0 : 60) - awayRating) / 400));
    const actual = row.homeGoals > row.awayGoals ? 1 : row.homeGoals === row.awayGoals ? .5 : 0;
    const change = (row.tournament === "Friendly" ? 20 : 32) * Math.min(1.8, 1 + Math.abs(row.homeGoals - row.awayGoals) * .12) * (actual - expected);
    ratings.set(row.home, homeRating + change); ratings.set(row.away, awayRating - change);
  });
  return ratings;
}

function internationalStats(team, rows, ratings) {
  const named = aliases[team] || team;
  const recent = rows.filter((row) => row.home === named || row.away === named).slice(-20);
  if (!recent.length) throw new Error(`No public international results found for ${team}.`);
  const values = recent.map((row) => {
    const home = row.home === named, daysOld = Math.max((Date.now() - new Date(`${row.date}T00:00:00Z`)) / 86400000, 0);
    return { goalsFor: home ? row.homeGoals : row.awayGoals, goalsAgainst: home ? row.awayGoals : row.homeGoals, weight: Math.exp(-daysOld / 540) * (row.tournament === "Friendly" ? 1 : 1.15) };
  });
  const weightTotal = values.reduce((sum, row) => sum + row.weight, 0), total = (row) => row.goalsFor + row.goalsAgainst;
  return { team, matches:recent.length, goalsFor:values.reduce((sum,row)=>sum+row.goalsFor*row.weight,0)/weightTotal, goalsAgainst:values.reduce((sum,row)=>sum+row.goalsAgainst*row.weight,0)/weightTotal, over15:values.filter((row)=>total(row)>1).length/values.length, over25:values.filter((row)=>total(row)>2).length/values.length, cleanSheet:values.filter((row)=>row.goalsAgainst===0).length/values.length, failedToScore:values.filter((row)=>row.goalsFor===0).length/values.length, elo:ratings.get(named)||1500 };
}

function predictWorldCupFixture(fixture, ratings = eloRatings(internationalRows)) {
  const first = internationalStats(fixture.home, internationalRows, ratings), second = internationalStats(fixture.away, internationalRows, ratings);
  const sample = internationalRows.slice(-5000), baseline = sample.reduce((sum,row)=>sum+row.homeGoals+row.awayGoals,0)/sample.length/2;
  const eloFactor = Math.exp((first.elo - second.elo) / 1200);
  let expectedFirst = baseline * (first.goalsFor / baseline) * (second.goalsAgainst / baseline) * eloFactor;
  let expectedSecond = baseline * (second.goalsFor / baseline) * (first.goalsAgainst / baseline) / eloFactor;
  if (hosts.has(fixture.home)) expectedFirst *= 1.08; if (hosts.has(fixture.away)) expectedSecond *= 1.08;
  expectedFirst = Math.max(.1, Math.min(expectedFirst, 4.5)); expectedSecond = Math.max(.1, Math.min(expectedSecond, 4.5));
  const total = expectedFirst + expectedSecond, outcomes = scoreProbabilities(expectedFirst, expectedSecond);
  return { first, second, expectedFirst, expectedSecond, total, outcomes, over15: poissonOver(total, 1), over25: poissonOver(total, 2), confidence: Math.min(first.matches, second.matches) >= 15 ? "Medium" : "Low" };
}

function analyzeWorldCup() {
  try {
    const fixture = worldCupFixtures[Number(byId("world-cup-fixture").value)], prediction = predictWorldCupFixture(fixture);
    const { first, second, expectedFirst, expectedSecond, total, outcomes } = prediction;
    byId("world-cup-title").textContent = `${fixture.home} vs ${fixture.away}`; byId("world-cup-subtitle").textContent = `Group ${fixture.group} / ${fixture.date} / ${fixture.venue}`; byId("world-cup-confidence").textContent = `${prediction.confidence} confidence`;
    byId("world-cup-metrics").innerHTML = metric("Expected total goals", num(total), "Neutral-site model") + metric(`${fixture.home} win`, pct(outcomes.firstWin), num(expectedFirst) + " xG") + metric("Draw", pct(outcomes.draw), "Score distribution") + metric(`${fixture.away} win`, pct(outcomes.secondWin), num(expectedSecond) + " xG");
    byId("world-cup-markets").innerHTML = market("Over 1.5 Goals", prediction.over15, Number(byId("world-cup-odds-15").value)) + market("Over 2.5 Goals", prediction.over25, Number(byId("world-cup-odds-25").value));
    byId("world-cup-home-heading").textContent = fixture.home; byId("world-cup-away-heading").textContent = fixture.away; byId("world-cup-summary").textContent = `${internationalRows.length.toLocaleString()} public internationals`;
    byId("world-cup-comparison-body").innerHTML = comparisonRow("Recent matches used", first.matches, second.matches) + comparisonRow("Weighted goals scored / game", num(first.goalsFor), num(second.goalsFor)) + comparisonRow("Weighted goals conceded / game", num(first.goalsAgainst), num(second.goalsAgainst)) + comparisonRow("Over 1.5 goals", pct(first.over15), pct(second.over15)) + comparisonRow("Over 2.5 goals", pct(first.over25), pct(second.over25)) + comparisonRow("Clean sheets", pct(first.cleanSheet), pct(second.cleanSheet)) + comparisonRow("Failed to score", pct(first.failedToScore), pct(second.failedToScore)) + comparisonRow("Local Elo rating", Math.round(first.elo), Math.round(second.elo));
  } catch (error) {
    byId("world-cup-title").textContent = error.message;
  }
}

async function getWorldCupOdds(fixture) {
  const params = new URLSearchParams({ date: fixture.date, home: fixture.home, away: fixture.away });
  const response = await fetch(`/api/world-cup-odds?${params.toString()}`);
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error || "No provider odds are available for this fixture yet.");
  return payload.best || {};
}

async function fetchWorldCupOdds() {
  const button = byId("world-cup-fetch-odds-button");
  const status = byId("world-cup-odds-status");
  const fixture = worldCupFixtures[Number(byId("world-cup-fixture").value)];
  if (!fixture) return;
  button.disabled = true;
  status.textContent = "Fetching latest provider odds...";
  try {
    const best = await getWorldCupOdds(fixture);
    const loaded = [];
    if (best.over_1_5) {
      byId("world-cup-odds-15").value = best.over_1_5.decimalOdds.toFixed(2);
      loaded.push(`Over 1.5 ${best.over_1_5.decimalOdds.toFixed(2)} from ${best.over_1_5.bookmaker}`);
    }
    if (best.over_2_5) {
      byId("world-cup-odds-25").value = best.over_2_5.decimalOdds.toFixed(2);
      loaded.push(`Over 2.5 ${best.over_2_5.decimalOdds.toFixed(2)} from ${best.over_2_5.bookmaker}`);
    }
    if (!loaded.length) throw new Error("The provider responded but did not include Over 1.5 or Over 2.5 prices.");
    status.textContent = loaded.join(" / ");
    analyzeWorldCup();
  } catch (error) {
    status.textContent = error.message;
  } finally {
    button.disabled = !worldCupReady;
  }
}

function valueFixtures() {
  const start = localIsoDate();
  const end = localIsoDate(addDays(new Date(), 2));
  return worldCupFixtures.filter((fixture) => fixture.date >= start && fixture.date <= end);
}

function valueCell(quote, probability) {
  if (!quote) return `<span class="muted-cell">No price</span>`;
  const result = oddsResult(quote.decimalOdds, probability);
  return `<div class="value-result"><span class="value-chip ${result.value ? "" : "no-value"}">${result.value ? "Value" : "No edge"}</span><small>Model ${num(1 / probability)} / odds ${quote.decimalOdds.toFixed(2)}</small></div>`;
}

function edgeCell(quote, probability) {
  if (!quote) return `<span class="muted-cell">-</span>`;
  const edge = oddsResult(quote.decimalOdds, probability).edge;
  const signed = `${edge >= 0 ? "+" : ""}${pct(edge)}`;
  return `<strong class="edge-score ${edge > 0 ? "positive" : "negative"}">${signed}</strong>`;
}

function oddsCell(quote) {
  return quote ? `<strong>${quote.decimalOdds.toFixed(2)}</strong><small>${quote.bookmaker}</small>` : `<span class="muted-cell">-</span>`;
}

async function refreshValueBoard() {
  await loadWorldCup();
  const button = byId("value-refresh-button");
  const status = byId("value-load-status");
  const body = byId("value-board-body");
  const fixtures = valueFixtures();
  if (!fixtures.length) {
    status.textContent = "No World Cup fixtures in the next 3 days.";
    body.innerHTML = `<tr><td colspan="8">No fixtures found for this window.</td></tr>`;
    return;
  }
  const ratings = eloRatings(internationalRows);
  button.disabled = true;
  status.textContent = `Scanning ${fixtures.length} fixtures...`;
  body.innerHTML = fixtures.map((fixture) => `<tr><td>${fixture.date}</td><td><strong>${fixture.home} vs ${fixture.away}</strong><small>Group ${fixture.group} / ${fixture.venue}</small></td><td colspan="6">Fetching odds...</td></tr>`).join("");
  const rows = [];
  for (const fixture of fixtures) {
    try {
      const prediction = predictWorldCupFixture(fixture, ratings);
      const best = await getWorldCupOdds(fixture);
      rows.push(`<tr><td>${fixture.date}</td><td><strong>${fixture.home} vs ${fixture.away}</strong><small>Group ${fixture.group} / ${fixture.venue}</small></td><td>${oddsCell(best.over_1_5)}</td><td>${valueCell(best.over_1_5, prediction.over15)}</td><td>${edgeCell(best.over_1_5, prediction.over15)}</td><td>${oddsCell(best.over_2_5)}</td><td>${valueCell(best.over_2_5, prediction.over25)}</td><td>${edgeCell(best.over_2_5, prediction.over25)}</td></tr>`);
    } catch (error) {
      rows.push(`<tr><td>${fixture.date}</td><td><strong>${fixture.home} vs ${fixture.away}</strong><small>Group ${fixture.group} / ${fixture.venue}</small></td><td colspan="6"><span class="muted-cell">${error.message}</span></td></tr>`);
    }
    body.innerHTML = rows.join("");
  }
  status.textContent = `${fixtures.length} fixtures scanned for ${localIsoDate()} to ${localIsoDate(addDays(new Date(), 2))}.`;
  button.disabled = false;
}

async function loadWorldCup() {
  if (worldCupReady) return;
  byId("data-status").textContent = "Loading World Cup datasets";
  byId("world-cup-load-status").textContent = "Loading public international results and group fixtures...";
  try {
    const [schedule, results] = await Promise.all([fetch("/data/world-cup-2026.txt").then((response) => response.text()), fetch("/data/international-results.csv").then((response) => response.text())]);
    worldCupFixtures = parseWorldCupSchedule(schedule);
    internationalRows = parseCsv(results).map((row) => ({ date:row.date, home:row.home_team, away:row.away_team, homeGoals:Number(row.home_score), awayGoals:Number(row.away_score), tournament:row.tournament, neutral:String(row.neutral).toLowerCase()==="true" })).filter((row) => row.date && row.date < new Date().toISOString().slice(0,10) && row.home && row.away && Number.isFinite(row.homeGoals) && Number.isFinite(row.awayGoals));
    byId("world-cup-fixture").innerHTML = worldCupFixtures.map((fixture,index)=>`<option value="${index}">${fixture.date} / Group ${fixture.group} / ${fixture.home} vs ${fixture.away}</option>`).join("");
    byId("world-cup-fixture").disabled = false; byId("world-cup-analyse-button").disabled = false; byId("world-cup-fetch-odds-button").disabled = false; byId("value-refresh-button").disabled = false; worldCupReady = true;
    byId("data-status").textContent = "World Cup datasets ready"; byId("world-cup-load-status").textContent = `${internationalRows.length.toLocaleString()} internationals / ${worldCupFixtures.length} group fixtures`;
    analyzeWorldCup();
  } catch (error) {
    byId("data-status").textContent = "World Cup data unavailable"; byId("world-cup-load-status").textContent = error.message; byId("world-cup-title").textContent = "Could not load the public World Cup datasets.";
  }
}

document.querySelectorAll("[data-view]").forEach((button) => button.addEventListener("click", () => {
  document.querySelectorAll("[data-view]").forEach((item) => item.classList.toggle("active", item === button));
  byId("league-view").classList.toggle("is-hidden", button.dataset.view !== "league");
  byId("world-cup-view").classList.toggle("is-hidden", button.dataset.view !== "world-cup");
  byId("value-view").classList.toggle("is-hidden", button.dataset.view !== "value");
  if (button.dataset.view === "world-cup") loadWorldCup();
  if (button.dataset.view === "value") refreshValueBoard();
}));

matches = parseCsv(await fetch("/data/demo_matches.csv").then((response) => response.text()));
teams = [...new Set(matches.flatMap((match) => [match.home_team, match.away_team]))].sort();
byId("league-select").innerHTML = `<option>Premier League / 2025-26 demo</option>`;
fillTeams();
byId("analyse-button").addEventListener("click", analyzeLeague);
byId("world-cup-analyse-button").addEventListener("click", analyzeWorldCup);
byId("world-cup-fetch-odds-button").addEventListener("click", fetchWorldCupOdds);
byId("world-cup-fixture").addEventListener("change", analyzeWorldCup);
byId("value-refresh-button").addEventListener("click", refreshValueBoard);
analyzeLeague();
