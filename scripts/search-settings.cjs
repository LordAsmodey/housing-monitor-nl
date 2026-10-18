"use strict";
// Source modules describe editable fields and where they are applied. No user URLs.
const modules = ["funda", "huurwoningen", "woldring", "vesteda", "gruno", "lamberink", "solide", "vandermeulen", "maxx", "rentsolutions", "rentola", "pararius"].map(
  (name) => require("./search-modules/" + name + ".cjs"),
);
function definition(id) {
  return modules.find((m) => m.id === id);
}
function defaults(id) {
  const m = definition(id);
  if (!m) throw Error("UNKNOWN_SOURCE");
  return Object.fromEntries(m.fields.map((f) => [f.key, f.value]));
}
function validate(id, input) {
  const m = definition(id);
  if (!m || !input || typeof input !== "object" || Array.isArray(input))
    throw Error("INVALID_FILTERS");
  if (Object.keys(input).some((k) => !m.fields.some((f) => f.key === k)))
    throw Error("UNKNOWN_FILTER");
  const result = {};
  for (const f of m.fields) {
    const v = input[f.key];
    if (v === null && f.nullable) {
      result[f.key] = null;
      continue;
    }
    if (
      typeof v !== "number" ||
      !Number.isFinite(v) ||
      v < f.min ||
      v > f.max ||
      !Number.isInteger(v / f.step)
    )
      throw Error("INVALID_" + f.key);
    result[f.key] = v;
  }
  if (result.maxRent !== null && result.minRent > result.maxRent)
    throw Error("INVALID_RENT_RANGE");
  return result;
}
function matches(filters, item, sourceId) {
  if (!filters) return true;
  if (
    filters.minArea !== null &&
    filters.minArea !== undefined &&
    (item.areaM2 === undefined || item.areaM2 < filters.minArea)
  )
    return false;
  // Query filters remain the site's responsibility; custom server rules live in its module.
  const custom = definition(sourceId)?.matches;
  return custom ? custom(filters, item) : true;
}
function queryUrl(id, base, filters) {
  const f = validate(id, filters);
  return definition(id).query(new URL(base), f).href;
}
const fingerprint = (filters) =>
  require("node:crypto")
    .createHash("sha256")
    .update(JSON.stringify(filters))
    .digest("hex");
module.exports = {
  modules,
  definition,
  defaults,
  validate,
  matches,
  queryUrl,
  fingerprint,
};
