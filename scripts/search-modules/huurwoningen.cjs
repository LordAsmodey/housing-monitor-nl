"use strict";
const { number, rent, area } = require("./fields.cjs");
module.exports = {
  key: "huurwoningen",
  id: "huurwoningen:groningen-25km-within-3-months",
  name: "Huurwoningen",
  note: "Groningen, заселение в течение 3 месяцев; обмен исключён. Остальные параметры поиска сохранены.",
  fields: [
    ...rent(0, 1500),
    number("radiusKm", "Радиус, км", 25, 5, 50, 5, false, "query"),
    area,
  ],
  query(url, f) {
    url.searchParams.set("price", `${f.minRent}-${f.maxRent}`);
    url.searchParams.set("radius", String(f.radiusKm));
    return url;
  },
};
