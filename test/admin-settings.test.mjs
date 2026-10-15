import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
const require = createRequire(import.meta.url);
const registry = require("../scripts/search-settings.cjs");
const funda = require("../scripts/funda-core.cjs");
const huur = require("../scripts/huurwoningen-core.cjs");
const auth = require("../scripts/admin-auth.cjs");

test("Gruno uses its configured budget before details and retains independent-housing checks", () => {
  const core = require("../scripts/gruno-core.cjs");
  const html = readFileSync(new URL("./fixtures/gruno-card.html", import.meta.url), "utf8");
  const settings = registry.defaults(core.SOURCE_ID);
  const narrow = core.createCore({...settings, maxRent: 1000});
  const broad = core.createCore({...settings, maxRent: 2000});
  assert.equal(narrow.candidate(narrow.parseCard(html)), false);
  assert.equal(broad.candidate(broad.parseCard(html)), true);
  assert.equal(broad.candidate(broad.parseCard(html.replace("benedenwoning, appartement", "Studentenkamer, appartement"))), false);
  assert.equal(core.FILTERS.maxAdvertisedRent, 1500);
  assert.equal(registry.matches({...settings, minRent:1300}, {rentPrice:1232}, core.SOURCE_ID), false);
});

test("source modules validate ranges, unknown fields and site-specific steps", () => {
  for (const m of registry.modules)
    assert.deepEqual(
      registry.validate(m.id, registry.defaults(m.id)),
      registry.defaults(m.id),
    );
  const f = registry.defaults(funda.SOURCE_ID);
  for (const patch of [
    { maxRent: -1 },
    { minRent: 2000 },
    { radiusKm: 27 },
    { minArea: "50" },
    { extra: 1 },
    { maxRent: Infinity },
    { minArea: 1001 },
  ])
    assert.throws(() => registry.validate(funda.SOURCE_ID, { ...f, ...patch }));
});
test("query modules produce isolated searches and retain URL allowlist guards", async () => {
  const filters = {
    ...registry.defaults(funda.SOURCE_ID),
    minRent: 700,
    maxRent: 1800,
    radiusKm: 10,
  };
  const core = funda.createCore(filters);
  const q = new URL(core.SEARCH_URL).searchParams;
  assert.equal(q.get("price"), "700-1800");
  assert.equal(q.get("radius_search"), "10");
  assert.throws(
    () => core.allowedUrl(funda.SEARCH_URL, "search"),
    /SEARCH_FILTER_CHANGED/,
  );
  assert.throws(
    () => core.allowedUrl("https://evil.example/zoeken/huur", "search"),
    /URL_NOT_ALLOWED/,
  );
  assert.equal(new URL(funda.SEARCH_URL).searchParams.get("price"), "0-1500");
  let requested;
  const result = await funda.collect({
    settings: filters,
    transport: async (url) => {
      requested = url;
      return new Response("<h1>0 huurwoningen</h1>", {
        headers: { "content-type": "text/html" },
      });
    },
  });
  assert.equal(new URL(requested).searchParams.get("price"), "700-1800");
  assert.equal(result.listings.length, 0);
});
test("Huurwoningen verifies the configured radius in rendered HTML", () => {
  const core = huur.createCore({
    ...registry.defaults(huur.SOURCE_ID),
    radiusKm: 10,
  });
  const empty = (radius) =>
    `<h1>Huurwoningen in een straal van ${radius} km van Groningen</h1><p>Binnen 3 maanden</p><section class="no-search-results"><h2 class="no-search-results__title">Helaas, er zijn geen woningen gevonden</h2></section>`;
  assert.equal(core.parseSearch(empty(10)).total, 0);
  assert.throws(() => core.parseSearch(empty(25)), /SEARCH_FILTER_CHANGED/);
});
test("server filters exclude unknown required values and never repeat query-side price rules", () => {
  const f = { minRent: 500, maxRent: 1500, minArea: 50 };
  assert.equal(
    registry.matches(
      f,
      { rentPrice: 900, areaM2: 60 },
      "woldring:apartments-studios",
    ),
    true,
  );
  assert.equal(
    registry.matches(f, { rentPrice: 900 }, "woldring:apartments-studios"),
    false,
  );
  assert.equal(
    registry.matches(
      f,
      { rentPrice: 1600, areaM2: 60 },
      "woldring:apartments-studios",
    ),
    false,
  );
  assert.equal(registry.matches(f, { areaM2: 60 }, huur.SOURCE_ID), true);
});
test("sessions have opaque independent tokens; only token hashes are persisted", () => {
  const a = auth.newSession(),
    b = auth.newSession();
  assert.notEqual(a.token, b.token);
  assert.notEqual(a.token, a.tokenHash);
  assert.equal(auth.hash(a.token), a.tokenHash);
  assert.equal(
    auth.cookieToken(`other=x; hm_admin=${a.token}; next=1`),
    a.token,
  );
  assert.equal(auth.cookieToken("hm_admin=malformed"), undefined);
  assert.equal(auth.equal(undefined, undefined), false);
  assert.equal(auth.equal("Admin", "Admin"), true);
  assert.equal(auth.equal("Admin", "admin"), false);
  assert.ok(a.expiresAt > Date.now());
});
test("browser client rejects workers that ignore settings, then accepts an acknowledged snapshot", async () => {
  const { browserClient } = require("../scripts/funda-browser-client.cjs");
  const settings = registry.defaults(funda.SOURCE_ID);
  const client = browserClient(
    "https://worker.up.railway.app",
    "a".repeat(32),
    async (_url, options) => {
      assert.deepEqual(JSON.parse(options.body), { settings });
      return Response.json({ listings: [], inspected: 0 });
    },
  );
  await assert.rejects(
    client.collect({ settings }),
    /BROWSER_SETTINGS_UNSUPPORTED/,
  );
  const ok = browserClient(
    "https://worker.up.railway.app",
    "a".repeat(32),
    async () =>
      Response.json({
        listings: [],
        inspected: 0,
        settingsFingerprint: registry.fingerprint(settings),
      }),
  );
  assert.equal((await ok.collect({ settings })).inspected, 0);
});
