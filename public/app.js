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
const localIsoDate = (date = new Date()) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const market = (label, probability, odds) => {
  const result = oddsResult(odds, probability);
  return `<article class="market-card"><div class="market-head"><h3>${label}</h3><span class="value-chip ${result.value ? "" : "no-value"}">${result.value ? "Potential value" : "No model edge"}</span></div><div class="market-stats"><div><span>Model probability</span><strong>${pct(probability)}</strong></div><div><span>Implied probability</span><strong>${pct(result.implied)}</strong></div><div><span>Expected value</span><strong>${pct(result.ev)}</strong></div></div></article>`;
};

let matches = [];
let teams = [];
let worldCupFixtures = [];
let internationalRows = [];
let worldCupReady = false;
const predictorStoreKey = "footballDataWorldCupPredictorV1";
let predictorState = { group: {}, knockout: {} };

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
const formShrinkMatches = 12, factorMin = .72, factorMax = 1.32, totalBaselineWeight = .28, eloGoalShareDivisor = 1400, hostGoalShareBoost = 1.04, totalGoalsMin = 1.35, totalGoalsMax = 3.35;
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

function clamp(value, lower, upper) {
  return Math.max(lower, Math.min(value, upper));
}

function rateFactor(rate, baseline, matches) {
  const weight = matches / (matches + formShrinkMatches);
  const shrunk = baseline + (rate - baseline) * weight;
  return clamp(shrunk / baseline, factorMin, factorMax);
}

function predictWorldCupFixture(fixture, ratings = eloRatings(internationalRows)) {
  const first = internationalStats(fixture.home, internationalRows, ratings), second = internationalStats(fixture.away, internationalRows, ratings);
  const sample = internationalRows.slice(-5000), baseline = sample.reduce((sum,row)=>sum+row.homeGoals+row.awayGoals,0)/sample.length/2;
  const firstAttack = rateFactor(first.goalsFor, baseline, first.matches), firstDefence = rateFactor(first.goalsAgainst, baseline, first.matches);
  const secondAttack = rateFactor(second.goalsFor, baseline, second.matches), secondDefence = rateFactor(second.goalsAgainst, baseline, second.matches);
  let rawFirst = baseline * firstAttack * secondDefence, rawSecond = baseline * secondAttack * firstDefence;
  if (hosts.has(fixture.home)) rawFirst *= hostGoalShareBoost; if (hosts.has(fixture.away)) rawSecond *= hostGoalShareBoost;
  const rawTotal = rawFirst + rawSecond, eloFactor = Math.exp((first.elo - second.elo) / eloGoalShareDivisor);
  const calibratedTotal = clamp(rawTotal * (1 - totalBaselineWeight) + baseline * 2 * totalBaselineWeight, totalGoalsMin, totalGoalsMax);
  const firstShare = rawFirst * eloFactor / (rawFirst * eloFactor + rawSecond);
  let expectedFirst = clamp(calibratedTotal * firstShare, .15, 3.2), expectedSecond = clamp(calibratedTotal - expectedFirst, .15, 3.2);
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

async function getWorldCupOdds(fixture, options = {}) {
  const params = new URLSearchParams({ date: fixture.date, home: fixture.home, away: fixture.away });
  if (options.snapshotDate) params.set("snapshotDate", options.snapshotDate);
  const response = await fetch(`/api/world-cup-odds?${params.toString()}`);
  const payload = await response.json();
  if (!response.ok) {
    const error = new Error(payload.error || "No provider odds are available for this fixture yet.");
    error.noPrice = Boolean(payload.noPrice);
    throw error;
  }
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
  const today = localIsoDate();
  return worldCupFixtures.filter((fixture) => fixture.date >= today);
}

function valueCell(quote, probability) {
  if (!quote) return `<span class="muted-cell">No price</span>`;
  const result = oddsResult(quote.decimalOdds, probability);
  return `<div class="value-result"><span class="value-chip ${result.value ? "" : "no-value"}">${result.value ? "Value" : "No edge"}</span><small>Fair ${num(1 / probability)} / odds ${quote.decimalOdds.toFixed(2)}</small></div>`;
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

function fixtureLabelCells(fixture) {
  return `<td>${fixture.date}</td><td><strong>${fixture.home} vs ${fixture.away}</strong><small>Group ${fixture.group} / ${fixture.venue}</small></td>`;
}

function isRateLimitError(message) {
  return /rate limit|quota|too many requests|429/i.test(message);
}

async function refreshValueBoard() {
  await loadWorldCup();
  const button = byId("value-refresh-button");
  const status = byId("value-load-status");
  const body = byId("value-board-body");
  const fixtures = valueFixtures();
  const snapshotDate = localIsoDate();
  if (!fixtures.length) {
    status.textContent = "No remaining World Cup group fixtures.";
    body.innerHTML = `<tr><td colspan="8">No upcoming fixtures found.</td></tr>`;
    return;
  }
  const ratings = eloRatings(internationalRows);
  button.disabled = true;
  status.textContent = `Loading ${snapshotDate} odds snapshot from upcoming fixtures...`;
  body.innerHTML = `<tr><td colspan="8">Scanning upcoming fixtures for published goal markets...</td></tr>`;
  const rows = [];
  let rateLimitMessage = "";
  let checked = 0;
  for (const fixture of fixtures) {
    if (rateLimitMessage) {
      break;
    }
    try {
      checked += 1;
      const prediction = predictWorldCupFixture(fixture, ratings);
      const best = await getWorldCupOdds(fixture, { snapshotDate });
      if (!best.over_1_5 && !best.over_2_5) continue;
      rows.push(`<tr>${fixtureLabelCells(fixture)}<td>${oddsCell(best.over_1_5)}</td><td>${valueCell(best.over_1_5, prediction.over15)}</td><td>${edgeCell(best.over_1_5, prediction.over15)}</td><td>${oddsCell(best.over_2_5)}</td><td>${valueCell(best.over_2_5, prediction.over25)}</td><td>${edgeCell(best.over_2_5, prediction.over25)}</td></tr>`);
    } catch (error) {
      if (error.noPrice) {
        body.innerHTML = rows.length ? rows.join("") : `<tr><td colspan="8">Scanning upcoming fixtures for published goal markets...</td></tr>`;
        await wait(1100);
        continue;
      }
      if (isRateLimitError(error.message)) {
        rateLimitMessage = `${rows.length} priced fixtures loaded before the provider limit was reached. Retry after the reset window.`;
      }
      if (!rateLimitMessage) rows.push(`<tr>${fixtureLabelCells(fixture)}<td colspan="6"><span class="muted-cell">${error.message}</span></td></tr>`);
    }
    body.innerHTML = rows.length ? rows.join("") : `<tr><td colspan="8">Scanning upcoming fixtures for published goal markets...</td></tr>`;
    await wait(1100);
  }
  if (!rows.length && rateLimitMessage) body.innerHTML = `<tr><td colspan="8"><span class="muted-cell">${rateLimitMessage}</span></td></tr>`;
  if (!rows.length && !rateLimitMessage) body.innerHTML = `<tr><td colspan="8">No published Over 1.5 or Over 2.5 markets found yet.</td></tr>`;
  status.textContent = rateLimitMessage || `${rows.length} priced fixtures found after checking ${checked} upcoming fixtures. Daily snapshot ${snapshotDate}.`;
  button.disabled = false;
}

const roundNames = { 32: "Round of 32", 16: "Round of 16", 8: "Quarterfinals", 4: "Semifinals", 2: "Final" };
const roundOrder = [32, 16, 8, 4, 2];
const roundOf32Slots = [
  { match: 73, home: { type:"runner", group:"A" }, away: { type:"runner", group:"B" } },
  { match: 74, home: { type:"winner", group:"E" }, away: { type:"third", groups:["A","B","C","D","F"] } },
  { match: 75, home: { type:"winner", group:"F" }, away: { type:"runner", group:"C" } },
  { match: 76, home: { type:"winner", group:"C" }, away: { type:"runner", group:"F" } },
  { match: 77, home: { type:"winner", group:"I" }, away: { type:"third", groups:["C","D","F","G","H"] } },
  { match: 78, home: { type:"runner", group:"E" }, away: { type:"runner", group:"I" } },
  { match: 79, home: { type:"winner", group:"A" }, away: { type:"third", groups:["C","E","F","H","I"] } },
  { match: 80, home: { type:"winner", group:"L" }, away: { type:"third", groups:["E","H","I","J","K"] } },
  { match: 81, home: { type:"winner", group:"D" }, away: { type:"third", groups:["B","E","F","I","J"] } },
  { match: 82, home: { type:"winner", group:"G" }, away: { type:"third", groups:["A","E","H","I","J"] } },
  { match: 83, home: { type:"runner", group:"K" }, away: { type:"runner", group:"L" } },
  { match: 84, home: { type:"winner", group:"H" }, away: { type:"runner", group:"J" } },
  { match: 85, home: { type:"winner", group:"B" }, away: { type:"third", groups:["E","F","G","I","J"] } },
  { match: 86, home: { type:"winner", group:"J" }, away: { type:"runner", group:"H" } },
  { match: 87, home: { type:"winner", group:"K" }, away: { type:"third", groups:["D","E","I","J","L"] } },
  { match: 88, home: { type:"runner", group:"D" }, away: { type:"runner", group:"G" } },
];
const knockoutLinks = {
  16: [[73,75],[74,77],[76,78],[79,80],[83,84],[81,82],[86,88],[85,87]],
  8: [[89,90],[93,94],[91,92],[95,96]],
  4: [[97,98],[99,100]],
  2: [[101,102]],
};

function loadPredictorState() {
  try {
    const saved = JSON.parse(localStorage.getItem(predictorStoreKey) || "{}");
    predictorState = { group: saved.group || {}, knockout: saved.knockout || {} };
  } catch {
    predictorState = { group: {}, knockout: {} };
  }
}

function savePredictorState() {
  localStorage.setItem(predictorStoreKey, JSON.stringify(predictorState));
}

function groupTeams() {
  return [..."ABCDEFGHIJKL"].reduce((groups, group) => {
    groups[group] = [...new Set(worldCupFixtures.filter((fixture) => fixture.group === group).flatMap((fixture) => [fixture.home, fixture.away]))];
    return groups;
  }, {});
}

function blankStanding(team, group) {
  return { team, group, played:0, wins:0, draws:0, losses:0, gf:0, ga:0, gd:0, points:0 };
}

function groupScore(index) {
  const score = predictorState.group[index] || {};
  const home = score.home === "" || score.home == null ? null : Number(score.home);
  const away = score.away === "" || score.away == null ? null : Number(score.away);
  return Number.isInteger(home) && Number.isInteger(away) && home >= 0 && away >= 0 ? { home, away } : null;
}

function applyResult(row, gf, ga) {
  row.played += 1; row.gf += gf; row.ga += ga; row.gd = row.gf - row.ga;
  if (gf > ga) { row.wins += 1; row.points += 3; }
  else if (gf === ga) { row.draws += 1; row.points += 1; }
  else row.losses += 1;
}

function compareRows(first, second) {
  return second.points - first.points || second.gd - first.gd || second.gf - first.gf || first.ga - second.ga || first.team.localeCompare(second.team);
}

function predictorTables() {
  const teamsByGroup = groupTeams();
  const tables = Object.fromEntries(Object.entries(teamsByGroup).map(([group, teams]) => [group, teams.map((team) => blankStanding(team, group))]));
  worldCupFixtures.forEach((fixture, index) => {
    const score = groupScore(index);
    if (!score) return;
    const home = tables[fixture.group].find((row) => row.team === fixture.home);
    const away = tables[fixture.group].find((row) => row.team === fixture.away);
    applyResult(home, score.home, score.away);
    applyResult(away, score.away, score.home);
  });
  Object.values(tables).forEach((table) => table.sort(compareRows));
  return tables;
}

function predictorCompletedGroups() {
  return Object.fromEntries([..."ABCDEFGHIJKL"].map((group) => [
    group,
    worldCupFixtures.filter((fixture) => fixture.group === group).every((fixture, index) => Boolean(groupScore(index))),
  ]));
}

function bestThirds(tables) {
  return Object.values(tables).map((table) => table[2]).sort(compareRows).slice(0, 8);
}

function resolveSeed(seed, tables, thirdPool, usedThirds) {
  if (seed.type === "winner") return tables[seed.group]?.[0]?.team || "";
  if (seed.type === "runner") return tables[seed.group]?.[1]?.team || "";
  const third = thirdPool.find((row) => seed.groups.includes(row.group) && !usedThirds.has(row.group));
  if (!third) return `3rd ${seed.groups.join("/")}`;
  usedThirds.add(third.group);
  return third.team;
}

function r32Matches(tables) {
  const thirds = bestThirds(tables);
  const usedThirds = new Set();
  return roundOf32Slots.map((slot) => ({ match: slot.match, round: 32, home: resolveSeed(slot.home, tables, thirds, usedThirds), away: resolveSeed(slot.away, tables, thirds, usedThirds) }));
}

function knockoutScore(match) {
  const score = predictorState.knockout[match] || {};
  const home = score.home === "" || score.home == null ? null : Number(score.home);
  const away = score.away === "" || score.away == null ? null : Number(score.away);
  return { home, away, winner: score.winner || "" };
}

function knockoutWinner(match) {
  const score = knockoutScore(match.match);
  if (!match.home || !match.away || match.home.startsWith("3rd ") || match.away.startsWith("3rd ")) return "";
  if (Number.isInteger(score.home) && Number.isInteger(score.away) && score.home >= 0 && score.away >= 0) {
    if (score.home > score.away) return match.home;
    if (score.away > score.home) return match.away;
    return score.winner;
  }
  return "";
}

function buildKnockout(tables) {
  const rounds = { 32: r32Matches(tables) };
  roundOrder.slice(1).forEach((round) => {
    const firstMatch = round === 16 ? 89 : round === 8 ? 97 : round === 4 ? 101 : 103;
    rounds[round] = knockoutLinks[round].map(([homeMatch, awayMatch], index) => {
      const previous = Object.values(rounds).flat();
      const home = knockoutWinner(previous.find((match) => match.match === homeMatch) || {});
      const away = knockoutWinner(previous.find((match) => match.match === awayMatch) || {});
      return { match: firstMatch + index, round, home, away };
    });
  });
  return rounds;
}

function renderGroupInputs() {
  byId("predictor-groups").innerHTML = [..."ABCDEFGHIJKL"].map((group) => {
    const fixtures = worldCupFixtures.map((fixture, index) => ({ ...fixture, index })).filter((fixture) => fixture.group === group);
    return `<section class="group-card"><h3>Group ${group}</h3>${fixtures.map((fixture) => {
      const score = predictorState.group[fixture.index] || {};
      return `<div class="score-row" data-group-fixture="${fixture.index}"><span>${fixture.date}</span><strong>${fixture.home}</strong><input type="number" min="0" inputmode="numeric" value="${score.home ?? ""}" aria-label="${fixture.home} goals" /><strong>${fixture.away}</strong><input type="number" min="0" inputmode="numeric" value="${score.away ?? ""}" aria-label="${fixture.away} goals" /></div>`;
    }).join("")}</section>`;
  }).join("");
}

function renderStandings(tables, completedGroups) {
  const thirds = new Set(bestThirds(tables).map((row) => `${row.group}:${row.team}`));
  byId("predictor-standings").innerHTML = Object.entries(tables).map(([group, rows]) => (
    `<section class="standing-card"><h3>Group ${group}<span>${completedGroups[group] ? "complete" : "open"}</span></h3><table><tbody>${rows.map((row, index) => {
      const qualifier = index < 2 || thirds.has(`${row.group}:${row.team}`);
      return `<tr class="${qualifier ? "qualified" : ""}"><td>${index + 1}</td><td>${row.team}</td><td>${row.points}</td><td>${row.gd >= 0 ? "+" : ""}${row.gd}</td></tr>`;
    }).join("")}</tbody></table></section>`
  )).join("");
}

function knockoutMatchCard(match) {
  const score = knockoutScore(match.match);
  const locked = !match.home || !match.away || match.home.startsWith("3rd ") || match.away.startsWith("3rd ");
  const tied = Number.isInteger(score.home) && Number.isInteger(score.away) && score.home === score.away && !locked;
  const winner = knockoutWinner(match);
  return `<article class="knockout-card ${winner ? "settled" : ""}" data-knockout-match="${match.match}">
    <span>Match ${match.match}</span>
    <div class="knockout-team"><strong>${match.home || "TBD"}</strong><input type="number" min="0" inputmode="numeric" value="${score.home ?? ""}" ${locked ? "disabled" : ""} aria-label="${match.home || "Home"} goals" /></div>
    <div class="knockout-team"><strong>${match.away || "TBD"}</strong><input type="number" min="0" inputmode="numeric" value="${score.away ?? ""}" ${locked ? "disabled" : ""} aria-label="${match.away || "Away"} goals" /></div>
    ${tied ? `<select aria-label="Tie winner"><option value="">Penalties winner</option><option ${score.winner === match.home ? "selected" : ""}>${match.home}</option><option ${score.winner === match.away ? "selected" : ""}>${match.away}</option></select>` : ""}
    ${winner ? `<small>${winner} advance</small>` : ""}
  </article>`;
}

function renderBracket(rounds) {
  byId("predictor-bracket").innerHTML = roundOrder.map((round) => (
    `<section class="bracket-round"><h3>${roundNames[round]}</h3>${rounds[round].map(knockoutMatchCard).join("")}</section>`
  )).join("");
}

function renderPredictor() {
  if (!worldCupReady) return;
  const tables = predictorTables();
  const completedGroups = predictorCompletedGroups();
  const groupScores = worldCupFixtures.filter((fixture, index) => Boolean(groupScore(index))).length;
  const completeGroupCount = Object.values(completedGroups).filter(Boolean).length;
  const rounds = buildKnockout(tables);
  const champion = knockoutWinner(rounds[2][0]);
  byId("predictor-load-status").textContent = `${groupScores}/72 group scores entered`;
  byId("predictor-group-status").textContent = `${completeGroupCount}/12 groups complete`;
  byId("predictor-knockout-status").textContent = champion ? `${champion} win the tournament` : "Bracket updates as winners advance";
  byId("predictor-progress").textContent = champion ? `Champion: ${champion}` : `${groupScores}/72 group fixtures scored. Complete the bracket to find a winner.`;
  byId("predictor-winner").textContent = champion ? `${champion} win the World Cup` : "Winner pending";
  renderGroupInputs();
  renderStandings(tables, completedGroups);
  renderBracket(rounds);
}

function updatePredictorGroupScore(row) {
  const index = row.dataset.groupFixture;
  const [home, away] = row.querySelectorAll("input");
  predictorState.group[index] = { home: home.value, away: away.value };
  if (!home.value && !away.value) delete predictorState.group[index];
  predictorState.knockout = {};
  savePredictorState();
  renderPredictor();
}

function updatePredictorKnockout(row) {
  const match = row.dataset.knockoutMatch;
  const [home, away] = row.querySelectorAll("input");
  const winner = row.querySelector("select")?.value || "";
  predictorState.knockout[match] = { home: home.value, away: away.value, winner };
  if (!home.value && !away.value && !winner) delete predictorState.knockout[match];
  savePredictorState();
  renderPredictor();
}

async function loadPredictor() {
  await loadWorldCup();
  loadPredictorState();
  byId("predictor-reset-button").disabled = false;
  renderPredictor();
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
    byId("world-cup-fixture").disabled = false; byId("world-cup-analyse-button").disabled = false; byId("world-cup-fetch-odds-button").disabled = false; byId("value-refresh-button").disabled = false; byId("predictor-reset-button").disabled = false; worldCupReady = true;
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
  byId("predictor-view").classList.toggle("is-hidden", button.dataset.view !== "predictor");
  if (button.dataset.view === "world-cup") loadWorldCup();
  if (button.dataset.view === "value") refreshValueBoard();
  if (button.dataset.view === "predictor") loadPredictor();
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
byId("predictor-groups").addEventListener("change", (event) => {
  const row = event.target.closest("[data-group-fixture]");
  if (row) updatePredictorGroupScore(row);
});
byId("predictor-bracket").addEventListener("change", (event) => {
  const row = event.target.closest("[data-knockout-match]");
  if (row) updatePredictorKnockout(row);
});
byId("predictor-reset-button").addEventListener("click", () => {
  predictorState = { group: {}, knockout: {} };
  savePredictorState();
  renderPredictor();
});
analyzeLeague();
