"use strict";
const { number, rent, area } = require("./fields.cjs");
module.exports = {
  key: "vesteda",
  id: "vesteda:groningen-20km-500-1500",
  name: "Vesteda",
  note: "Groningen. Цена и радиус передаются в поиск Vesteda; площадь проверяется сервером.",
  fields: [
    ...rent(500, 1500),
    number("radiusKm", "Радиус, км", 20, 0, 50, 5, false, "query"),
    area,
  ],
  query(url, f) {
    url.searchParams.set("priceFrom", String(f.minRent));
    url.searchParams.set("priceTo", String(f.maxRent));
    url.searchParams.set("radius", String(f.radiusKm));
    return url;
  },
};
