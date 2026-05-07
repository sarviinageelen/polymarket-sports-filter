(function attachSportsFilter(root, factory) {
  const api = factory();

  if (typeof module === "object" && module.exports) {
    module.exports = api;
  }

  if (root) {
    root.PolymarketSportsFilter = Object.assign({}, root.PolymarketSportsFilter, api);
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function createSportsFilter() {
  const DEFAULT_SELECTED_SPORTS = Object.freeze(["nba"]);

  const SPORT_OPTIONS = Object.freeze([
    { id: "nba", label: "NBA" },
    { id: "nfl", label: "NFL" },
    { id: "mlb", label: "MLB" },
    { id: "nhl", label: "NHL" },
    { id: "soccer", label: "Soccer" },
    { id: "tennis", label: "Tennis" },
    { id: "esports", label: "Esports" },
  ]);

  const CATEGORY_DEFINITIONS = Object.freeze({
    nba: {
      label: "NBA",
      keywords: [
        "nba",
        "national basketball association",
        "nba finals",
        "nba championship",
        "play-in tournament",
        "basketball playoffs",
        "lakers",
        "los angeles lakers",
        "la lakers",
        "thunder",
        "oklahoma city thunder",
        "okc thunder",
        "knicks",
        "new york knicks",
        "76ers",
        "sixers",
        "philadelphia 76ers",
        "timberwolves",
        "minnesota timberwolves",
        "cavaliers",
        "cleveland cavaliers",
        "celtics",
        "boston celtics",
        "spurs",
        "san antonio spurs",
        "suns",
        "phoenix suns",
        "hawks",
        "atlanta hawks",
        "nets",
        "brooklyn nets",
        "hornets",
        "charlotte hornets",
        "bulls",
        "chicago bulls",
        "mavericks",
        "dallas mavericks",
        "nuggets",
        "denver nuggets",
        "pistons",
        "detroit pistons",
        "warriors",
        "golden state warriors",
        "rockets",
        "houston rockets",
        "pacers",
        "indiana pacers",
        "clippers",
        "la clippers",
        "los angeles clippers",
        "grizzlies",
        "memphis grizzlies",
        "miami heat",
        "bucks",
        "milwaukee bucks",
        "pelicans",
        "new orleans pelicans",
        "orlando magic",
        "raptors",
        "toronto raptors",
        "trail blazers",
        "portland trail blazers",
        "sacramento kings",
        "utah jazz",
        "wizards",
        "washington wizards",
      ],
      fallbackKeywords: ["playoffs", "playoff"],
    },
    nfl: {
      label: "NFL",
      keywords: [
        "nfl",
        "national football league",
        "super bowl",
        "afc championship",
        "nfc championship",
        "chiefs",
        "kansas city chiefs",
        "eagles",
        "philadelphia eagles",
        "cowboys",
        "dallas cowboys",
        "packers",
        "green bay packers",
        "bills",
        "buffalo bills",
        "ravens",
        "baltimore ravens",
        "49ers",
        "san francisco 49ers",
        "niners",
        "lions",
        "detroit lions",
        "bengals",
        "cincinnati bengals",
        "dolphins",
        "miami dolphins",
        "jets",
        "new york jets",
        "giants",
        "new york giants",
        "patriots",
        "new england patriots",
        "steelers",
        "pittsburgh steelers",
        "browns",
        "cleveland browns",
        "texans",
        "houston texans",
        "colts",
        "indianapolis colts",
        "jaguars",
        "jacksonville jaguars",
        "titans",
        "tennessee titans",
        "broncos",
        "denver broncos",
        "raiders",
        "las vegas raiders",
        "chargers",
        "los angeles chargers",
        "commanders",
        "washington commanders",
        "bears",
        "chicago bears",
        "vikings",
        "minnesota vikings",
        "falcons",
        "atlanta falcons",
        "panthers",
        "carolina panthers",
        "saints",
        "new orleans saints",
        "buccaneers",
        "tampa bay buccaneers",
        "cardinals",
        "arizona cardinals",
        "rams",
        "los angeles rams",
        "seahawks",
        "seattle seahawks",
      ],
    },
    mlb: {
      label: "MLB",
      keywords: [
        "mlb",
        "major league baseball",
        "world series",
        "baseball",
        "yankees",
        "new york yankees",
        "dodgers",
        "los angeles dodgers",
        "mets",
        "new york mets",
        "red sox",
        "boston red sox",
        "cubs",
        "chicago cubs",
        "white sox",
        "chicago white sox",
        "astros",
        "houston astros",
        "braves",
        "atlanta braves",
        "phillies",
        "philadelphia phillies",
        "padres",
        "san diego padres",
        "giants",
        "san francisco giants",
        "blue jays",
        "toronto blue jays",
        "cardinals",
        "st louis cardinals",
        "orioles",
        "baltimore orioles",
        "rangers",
        "texas rangers",
        "mariners",
        "seattle mariners",
      ],
    },
    nhl: {
      label: "NHL",
      keywords: [
        "nhl",
        "national hockey league",
        "stanley cup",
        "hockey",
        "maple leafs",
        "toronto maple leafs",
        "leafs",
        "rangers",
        "new york rangers",
        "bruins",
        "boston bruins",
        "canadiens",
        "montreal canadiens",
        "oilers",
        "edmonton oilers",
        "canucks",
        "vancouver canucks",
        "avalanche",
        "colorado avalanche",
        "golden knights",
        "vegas golden knights",
        "lightning",
        "tampa bay lightning",
        "panthers",
        "florida panthers",
        "penguins",
        "pittsburgh penguins",
        "red wings",
        "detroit red wings",
        "blackhawks",
        "chicago blackhawks",
        "devils",
        "new jersey devils",
        "islanders",
        "new york islanders",
        "hurricanes",
        "carolina hurricanes",
        "stars",
        "dallas stars",
        "los angeles kings",
      ],
    },
    soccer: {
      label: "Soccer",
      keywords: [
        "soccer",
        "premier league",
        "champions league",
        "europa league",
        "world cup",
        "uefa",
        "fifa",
        "mls",
        "la liga",
        "serie a",
        "bundesliga",
        "arsenal",
        "chelsea",
        "liverpool",
        "manchester city",
        "man city",
        "manchester united",
        "man united",
        "tottenham",
        "real madrid",
        "barcelona",
        "psg",
        "paris saint germain",
        "inter miami",
        "bayern munich",
        "borussia dortmund",
        "juventus",
        "inter milan",
        "ac milan",
      ],
    },
    tennis: {
      label: "Tennis",
      keywords: [
        "tennis",
        "atp",
        "wta",
        "grand slam",
        "wimbledon",
        "us open tennis",
        "australian open",
        "french open",
        "roland garros",
        "djokovic",
        "novak djokovic",
        "alcaraz",
        "carlos alcaraz",
        "sinner",
        "jannik sinner",
        "nadal",
        "rafael nadal",
        "federer",
        "roger federer",
        "swiatek",
        "iga swiatek",
        "sabalenka",
        "aryna sabalenka",
        "coco gauff",
      ],
    },
    esports: {
      label: "Esports",
      keywords: [
        "esports",
        "e-sports",
        "league of legends",
        "lol worlds",
        "valorant",
        "counter-strike",
        "counter strike",
        "cs2",
        "dota",
        "dota 2",
        "overwatch",
        "call of duty league",
        "cod league",
        "rocket league",
        "fortnite",
        "faze clan",
        "cloud9",
        "team liquid",
        "g2 esports",
        "t1",
        "fnatic",
        "natus vincere",
        "navi",
      ],
    },
    crypto: {
      label: "Crypto",
      keywords: [
        "bitcoin",
        "btc",
        "ethereum",
        "eth",
        "solana",
        "sol",
        "dogecoin",
        "doge",
        "xrp",
        "crypto",
        "cryptocurrency",
        "stablecoin",
        "usdc",
        "tether",
        "binance",
        "coinbase",
        "etf",
        "satoshi",
      ],
    },
    politics: {
      label: "Politics",
      keywords: [
        "election",
        "president",
        "presidential",
        "trump",
        "donald trump",
        "biden",
        "joe biden",
        "harris",
        "kamala harris",
        "congress",
        "senate",
        "house of representatives",
        "governor",
        "mayor",
        "supreme court",
        "scotus",
        "democrat",
        "republican",
        "gop",
        "primary",
        "polling",
      ],
    },
  });

  const SPORT_IDS = new Set(SPORT_OPTIONS.map((option) => option.id));
  const PATTERN_CACHE = new Map();

  function normalizeText(value) {
    return String(value || "")
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/&/g, " and ")
      .replace(/\s+/g, " ")
      .trim()
      .toLowerCase();
  }

  function escapeRegex(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  function keywordToPattern(keyword) {
    const tokens = normalizeText(keyword)
      .split(/[^a-z0-9]+/)
      .filter(Boolean)
      .map(escapeRegex);

    if (!tokens.length) {
      return null;
    }

    return new RegExp(`(^|[^a-z0-9])${tokens.join("[^a-z0-9]+")}([^a-z0-9]|$)`, "i");
  }

  function getPatterns(category, key) {
    const cacheKey = `${category}:${key}`;

    if (!PATTERN_CACHE.has(cacheKey)) {
      const definition = CATEGORY_DEFINITIONS[category] || {};
      const keywords = definition[key] || [];
      PATTERN_CACHE.set(
        cacheKey,
        keywords.map(keywordToPattern).filter(Boolean)
      );
    }

    return PATTERN_CACHE.get(cacheKey);
  }

  function hasPatternMatch(text, category, key) {
    return getPatterns(category, key).some((pattern) => pattern.test(text));
  }

  function classifyMarketText(value) {
    const text = normalizeText(value);

    if (!text) {
      return [];
    }

    const strongMatches = [];
    const categories = Object.keys(CATEGORY_DEFINITIONS);

    categories.forEach((category) => {
      if (hasPatternMatch(text, category, "keywords")) {
        strongMatches.push(category);
      }
    });

    const matches = new Set(strongMatches);

    categories.forEach((category) => {
      if (!hasPatternMatch(text, category, "fallbackKeywords")) {
        return;
      }

      if (strongMatches.length === 0 || strongMatches.includes(category)) {
        matches.add(category);
      }
    });

    return categories.filter((category) => matches.has(category));
  }

  function normalizeSelectedSports(selectedSports) {
    if (!Array.isArray(selectedSports)) {
      return DEFAULT_SELECTED_SPORTS.slice();
    }

    const normalized = [];

    selectedSports.forEach((sport) => {
      if (SPORT_IDS.has(sport) && !normalized.includes(sport)) {
        normalized.push(sport);
      }
    });

    return normalized.length ? normalized : DEFAULT_SELECTED_SPORTS.slice();
  }

  function matchesSelectedSports(text, selectedSports) {
    const selected = new Set(normalizeSelectedSports(selectedSports));
    const categories = classifyMarketText(text);

    if (!categories.length) {
      return false;
    }

    return categories.some((category) => selected.has(category));
  }

  function hasKnownCategory(text) {
    return classifyMarketText(text).length > 0;
  }

  return {
    CATEGORY_DEFINITIONS,
    DEFAULT_SELECTED_SPORTS,
    SPORT_OPTIONS,
    classifyMarketText,
    hasKnownCategory,
    matchesSelectedSports,
    normalizeSelectedSports,
    normalizeText,
  };
});
