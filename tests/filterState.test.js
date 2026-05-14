const assert = require("node:assert/strict");

const {
  buildDiagnosticsMessage,
  formatSelectedSportsLabel,
} = require("../src/filterState");

const sports = [
  { id: "nba", label: "NBA" },
  { id: "nfl", label: "NFL" },
  { id: "esports", label: "Esports" },
];

function test(name, fn) {
  try {
    fn();
    console.log(`ok - ${name}`);
  } catch (error) {
    console.error(`not ok - ${name}`);
    throw error;
  }
}

test("formats selected sport labels", () => {
  assert.equal(formatSelectedSportsLabel(["nba"], sports), "NBA");
  assert.equal(formatSelectedSportsLabel(["nba", "nfl"], sports), "NBA, NFL");
  assert.equal(formatSelectedSportsLabel(["unknown", "esports"], sports), "Esports");
});

test("explains unsupported pages", () => {
  assert.equal(
    buildDiagnosticsMessage({ isProfilePage: false }, ["nba"], sports),
    "Open a supported Polymarket profile page to use the filter."
  );
});

test("explains a page before rows render", () => {
  assert.equal(
    buildDiagnosticsMessage({ isProfilePage: true, renderedRows: 0 }, ["nba"], sports),
    "Polymarket has not rendered profile rows yet. Try switching tabs or scrolling."
  );
});

test("explains a blank NBA-only batch", () => {
  assert.equal(
    buildDiagnosticsMessage(
      { isProfilePage: true, renderedRows: 23, matchingRows: 0, hiddenRows: 23 },
      ["nba"],
      sports
    ),
    "The current loaded batch has no NBA rows."
  );
});

test("explains visible matching rows", () => {
  assert.equal(
    buildDiagnosticsMessage(
      { isProfilePage: true, renderedRows: 48, matchingRows: 4, hiddenRows: 44 },
      ["nba"],
      sports
    ),
    "Showing matching NBA rows from the current loaded batch."
  );
});
