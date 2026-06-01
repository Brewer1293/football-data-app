const byId = (id) => document.querySelector(`#${id}`);
const pct = (value) => `${(value * 100).toFixed(1)}%`;
const num = (value) => Number(value).toFixed(2);
const factorial = (n) => Array.from({ length: n }, (_, index) => index + 1).reduce((value, part) => value * part, 1);
const poissonOver = (lambda, threshold) => 1 - Array.from({ length: threshold + 1 }, (_, goals) => Math.exp(-lambda) * lambda ** goals / factorial(goals)).reduce((sum, value) => sum + value, 0);
const positive = (value, fallback) => Math.max(Number(value ?? fallback), 0.05);

let matches = [];
let teams = [];

function parseCsv(text) {
  const [header, ...rows] = text.trim().split(/\r?\n/).map((line) => line.split(","));
  return rows.map((row) => Object.fromEntries(header.map((key, index) => [key, row[index]])));
}

function teamRows(team) {
  return matches.filter((match) => match.home_team === team || match.away_team === team).map((match) => {
    const home = match.home_team === team;
    return { venue: home ? "home" : "away", goalsFor: Number(home ? match.home_goals : match.away_goals), goalsAgainst: Number(home ? match.away_goals : match.home_goals), xgFor: Number(home ? match.home_xg : match.away_xg), xgAgainst: Number(home ? match.away_xg : match.home_xg), date: match.date };
  }).sort((a, b) => a.date.localeCompare(b.date));
}

const average = (rows, key) => rows.reduce((total, row) => total + row[key], 0) / rows.length;
function summarize(team) {
  const rows = teamRows(team);
  const home = rows.filter((row) => row.venue === "home");
  const away = rows.filter((row) => row.venue === "away");
  const totalGoals = (row) => row.goalsFor + row.goalsAgainst;
  return { matchesPlayed: rows.length, goalsScored: average(rows, "goalsFor"), goalsConceded: average(rows, "goalsAgainst"), homeGoalsScored: average(home, "goalsFor"), homeGoalsConceded: average(home, "goalsAgainst"), awayGoalsScored: average(away, "goalsFor"), awayGoalsConceded: average(away, "goalsAgainst"), over15: rows.filter((row) => totalGoals(row) > 1).length / rows.length, over25: rows.filter((row) => totalGoals(row) > 2).length / rows.length, cleanSheet: rows.filter((row) => row.goalsAgainst === 0).length / rows.length, failedToScore: rows.filter((row) => row.goalsFor === 0).length / rows.length, xgFor: average(rows, "xgFor"), xgAgainst: average(rows, "xgAgainst") };
}
function recent(team) { const rows = teamRows(team).slice(-5); return { goalsScored: average(rows, "goalsFor"), over25: rows.filter((row) => row.goalsFor + row.goalsAgainst > 2).length / rows.length }; }
function leagueStats() { return { avgHome: average(matches.map((match) => ({ value: Number(match.home_goals) })), "value"), avgAway: average(matches.map((match) => ({ value: Number(match.away_goals) })), "value") }; }
function model(home, away, homeRecent, awayRecent, league) {
  let expectedHome = positive(league.avgHome, 1.4) * (positive(home.homeGoalsScored, league.avgHome) / league.avgHome) * (positive(away.awayGoalsConceded, league.avgHome) / league.avgHome);
  let expectedAway = positive(league.avgAway, 1.1) * (positive(away.awayGoalsScored, league.avgAway) / league.avgAway) * (positive(home.homeGoalsConceded, league.avgAway) / league.avgAway);
  const recentFactor = Math.max(.85, Math.min(1.15, (homeRecent.goalsScored + awayRecent.goalsScored) / Math.max(home.goalsScored + away.goalsScored, .1)));
  expectedHome *= .8 + .2 * recentFactor; expectedAway *= .8 + .2 * recentFactor;
  expectedHome = .8 * expectedHome + .2 * (home.xgFor + away.xgAgainst) / 2;
  expectedAway = .8 * expectedAway + .2 * (away.xgFor + home.xgAgainst) / 2;
  const total = Math.max(.1, Math.min(expectedHome + expectedAway, 6));
  return { expectedHome, expectedAway, total, over15: poissonOver(total, 1), over25: poissonOver(total, 2), confidence: Math.min(home.matchesPlayed, away.matchesPlayed) >= 8 ? "Medium confidence" : "Low confidence" };
}
function oddsResult(odds, probability) { const implied = 1 / odds; return { implied, edge: probability - implied, ev: odds * probability - 1, value: probability > implied }; }
const metric = (label, value, note) => `<article class="metric"><span>${label}</span><strong>${value}</strong><small>${note}</small></article>`;
function market(label, probability, odds) { const result = oddsResult(odds, probability); return `<article class="market-card"><div class="market-head"><h3>${label}</h3><span class="value-chip ${result.value ? "" : "no-value"}">${result.value ? "Potential value" : "No model edge"}</span></div><div class="market-stats"><div><span>Model probability</span><strong>${pct(probability)}</strong></div><div><span>Implied probability</span><strong>${pct(result.implied)}</strong></div><div><span>Expected value</span><strong>${pct(result.ev)}</strong></div></div></article>`; }
function comparisonRow(label, home, away) { return `<tr><td>${label}</td><td>${home}</td><td>${away}</td></tr>`; }
function analyze() {
  const homeName = byId("home-team").value, awayName = byId("away-team").value;
  const home = summarize(homeName), away = summarize(awayName), league = leagueStats(), result = model(home, away, recent(homeName), recent(awayName), league);
  byId("fixture-title").textContent = `${homeName} vs ${awayName}`; byId("fixture-subtitle").textContent = "Premier League demo analysis"; byId("confidence").textContent = result.confidence;
  byId("metrics").innerHTML = metric("Expected total goals", num(result.total), "Poisson total") + metric("Expected home goals", num(result.expectedHome), homeName) + metric("Expected away goals", num(result.expectedAway), awayName);
  byId("markets").innerHTML = market("Over 1.5 Goals", result.over15, Number(byId("odds-15").value)) + market("Over 2.5 Goals", result.over25, Number(byId("odds-25").value));
  byId("home-heading").textContent = homeName; byId("away-heading").textContent = awayName; byId("league-summary").textContent = `League average: ${num(league.avgHome + league.avgAway)} goals`;
  byId("comparison-body").innerHTML = comparisonRow("Season matches", home.matchesPlayed, away.matchesPlayed) + comparisonRow("Goals scored / game", num(home.goalsScored), num(away.goalsScored)) + comparisonRow("Goals conceded / game", num(home.goalsConceded), num(away.goalsConceded)) + comparisonRow("Home / away goals scored", num(home.homeGoalsScored), num(away.awayGoalsScored)) + comparisonRow("Over 1.5 goals", pct(home.over15), pct(away.over15)) + comparisonRow("Over 2.5 goals", pct(home.over25), pct(away.over25)) + comparisonRow("xG for / game", num(home.xgFor), num(away.xgFor));
}
function fillTeams() { const options = teams.map((team) => `<option>${team}</option>`).join(""); byId("home-team").innerHTML = options; byId("away-team").innerHTML = options; byId("away-team").selectedIndex = 1; }
matches = parseCsv(await (await fetch("/data/demo_matches.csv")).text()); teams = [...new Set(matches.flatMap((match) => [match.home_team, match.away_team]))].sort(); byId("league-select").innerHTML = `<option>Premier League / 2025-26 demo</option>`; fillTeams(); byId("analyse-button").addEventListener("click", analyze); analyze();
