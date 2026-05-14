const assert = require("node:assert/strict");

const {
  DEFAULT_SELECTED_SPORTS,
  SPORT_OPTIONS,
  classifyMarketText,
  matchesSelectedSports,
  normalizeSelectedSports,
  shouldHideForSelectedSports,
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
  assert.deepEqual(classifyMarketText("/sports/nba/games BOS vs DAL: Game spread"), ["nba"]);
  assert.deepEqual(classifyMarketText("NYK vs ATL"), ["nba"]);
  assert.deepEqual(classifyMarketText("LAL vs OKC"), ["nba"]);
  assert.deepEqual(classifyMarketText("/sports/nba/games Hornets vs. Nets"), ["nba"]);
});

test("hides non-NBA sports and non-sports when NBA is selected", () => {
  assert.equal(matchesSelectedSports("Chiefs vs. Eagles", ["nba"]), false);
  assert.equal(matchesSelectedSports("NFL playoffs: Chiefs vs. Eagles", ["nba"]), false);
  assert.equal(matchesSelectedSports("Yankees vs. Dodgers", ["nba"]), false);
  assert.equal(matchesSelectedSports("Will Bitcoin hit $100k in 2026?", ["nba"]), false);
  assert.equal(matchesSelectedSports("Will Trump win the election?", ["nba"]), false);
  assert.equal(matchesSelectedSports("/esports/cs2/games Counter-Strike: G2 vs Fluxo W7M", ["nba"]), false);
  assert.equal(matchesSelectedSports("/event/lol-fox1-gen-2026-05-14 Game Handicap: GEN vs BNK FEARX", ["nba"]), false);
  assert.equal(matchesSelectedSports("LoL: Invictus Gaming vs Bilibili Gaming", ["nba"]), false);
  assert.equal(matchesSelectedSports("UFC 328: Yaroslav Amosov vs Joel Alvarez", ["nba"]), false);
  assert.equal(matchesSelectedSports("/sports/nba/games Chicago Sky vs. Golden State Valkyries", ["nba"]), false);
  assert.equal(matchesSelectedSports("/sports/nhl/games/min-vs-col Wild vs. Avalanche Wild", ["nba"]), false);
  assert.equal(matchesSelectedSports("/event/lal-ala-bar-2026-05-13 Will Deportivo Alavés vs. FC Barcelona end in a draw?", ["nba"]), false);
  assert.equal(
    matchesSelectedSports(
      "Buy Wild vs. Avalanche Wild event nhl min col 2026 event nhl min col 2026 event nhl min col 2026",
      ["nba"]
    ),
    false
  );
  assert.equal(
    matchesSelectedSports(
      "Redeem Will Deportivo Alavés vs. FC Barcelona end in a draw? event lal ala bar 2026 event lal ala bar 2026",
      ["nba"]
    ),
    false
  );
  assert.equal(matchesSelectedSports("/sports/atp/games Felix Auger-Aliassime vs Jannik Sinner", ["nba"]), false);
});

test("classifies LoL activity and event slugs as esports", () => {
  assert.deepEqual(classifyMarketText("LoL: Weibo Gaming vs JD Gaming (BO3) - LPL Group Ascend"), ["esports"]);
  assert.deepEqual(classifyMarketText("/event/lol-fox1-gen-2026-05-14 Game Handicap: GEN vs BNK FEARX"), ["esports"]);
});

test("hides everything except selected sports rows", () => {
  assert.equal(shouldHideForSelectedSports("Lakers vs. Thunder", ["nba"]), false);
  assert.equal(shouldHideForSelectedSports("Chiefs vs. Eagles", ["nba"]), true);
  assert.equal(shouldHideForSelectedSports("Valencia vs. Panathinaikos", ["nba"]), true);
  assert.equal(shouldHideForSelectedSports("Gaza flotilla enters Israeli waters by May 31?", ["nba"]), true);
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
