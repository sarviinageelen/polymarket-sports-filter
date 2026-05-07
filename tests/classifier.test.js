const assert = require("node:assert/strict");

const {
  DEFAULT_SELECTED_SPORTS,
  SPORT_OPTIONS,
  classifyMarketText,
  matchesSelectedSports,
  normalizeSelectedSports,
} = require("../src/sportClassifier");

function test(name, fn) {
  try {
    fn();
    console.log(`ok - ${name}`);
  } catch (error) {
    console.error(`not ok - ${name}`);
    throw error;
  }
}

test("defaults to NBA only", () => {
  assert.deepEqual(DEFAULT_SELECTED_SPORTS, ["nba"]);
  assert.equal(normalizeSelectedSports([]).join(","), "nba");
});

test("offers required sports options", () => {
  const ids = SPORT_OPTIONS.map((option) => option.id);
  assert.deepEqual(ids, [
    "nba",
    "nfl",
    "mlb",
    "nhl",
    "soccer",
    "tennis",
    "esports",
  ]);
});

test("classifies NBA markets by league terms and team names", () => {
  assert.deepEqual(classifyMarketText("NBA playoffs: Celtics vs. Spurs"), ["nba"]);
  assert.deepEqual(classifyMarketText("Playoffs Game 3 winner"), ["nba"]);
  assert.deepEqual(classifyMarketText("Lakers vs. Thunder"), ["nba"]);
  assert.deepEqual(classifyMarketText("Knicks vs. 76ers"), ["nba"]);
  assert.deepEqual(classifyMarketText("Timberwolves vs. Cavaliers"), ["nba"]);
  assert.deepEqual(classifyMarketText("Suns vs. Clippers - Game 7"), ["nba"]);
  assert.deepEqual(classifyMarketText("/sports/nba/games Hornets vs. Nets"), ["nba"]);
});

test("hides non-NBA sports and non-sports when NBA is selected", () => {
  assert.equal(matchesSelectedSports("Chiefs vs. Eagles", ["nba"]), false);
  assert.equal(matchesSelectedSports("NFL playoffs: Chiefs vs. Eagles", ["nba"]), false);
  assert.equal(matchesSelectedSports("Yankees vs. Dodgers", ["nba"]), false);
  assert.equal(matchesSelectedSports("Will Bitcoin hit $100k in 2026?", ["nba"]), false);
  assert.equal(matchesSelectedSports("Will Trump win the election?", ["nba"]), false);
  assert.equal(matchesSelectedSports("/esports/cs2/games Counter-Strike: G2 vs Fluxo W7M", ["nba"]), false);
  assert.equal(matchesSelectedSports("/sports/atp/games Felix Auger-Aliassime vs Jannik Sinner", ["nba"]), false);
});

test("shows all selected sports when multiple sports are enabled", () => {
  assert.equal(matchesSelectedSports("Lakers vs. Thunder", ["nba", "nfl"]), true);
  assert.equal(matchesSelectedSports("Chiefs vs. Eagles", ["nba", "nfl"]), true);
  assert.equal(matchesSelectedSports("Yankees vs. Dodgers", ["nba", "nfl"]), false);
});

test("normalizes invalid or duplicate selections", () => {
  assert.deepEqual(normalizeSelectedSports(["nba", "nba", "crypto", "nfl"]), ["nba", "nfl"]);
  assert.deepEqual(normalizeSelectedSports(["crypto"]), ["nba"]);
});
