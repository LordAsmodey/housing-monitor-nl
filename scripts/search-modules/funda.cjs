"use strict";
const { number, rent, area } = require("./fields.cjs");
module.exports = {
  key: "funda",
  id: "funda:groningen-30km-1500-3d",
  name: "Funda",
  note: "Groningen, публикации за сегодня. Цена — объявленная месячная аренда, без добавления servicekosten.",
  fields: [
    ...rent(0, 1500),
    number("radiusKm", "Радиус, км", 30, 0, 50, 5, false, "query"),
    area,
  ],
  query(url, f) {
    url.searchParams.set("price", `${f.minRent}-${f.maxRent}`);
    url.searchParams.set("radius_search", String(f.radiusKm));
    return url;
  },
};
