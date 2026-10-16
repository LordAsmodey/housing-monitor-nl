"use strict";
const { number, area } = require("./fields.cjs");
module.exports = {
  key: "maxx", id: "maxx:groningen-homes", name: "Maxx Huren",
  note: "Groningen: квартиры, студии и дома; без комнат. Максимальная цена — в поиске сайта; минимальная цена и площадь — перед уведомлением. Дополнительные расходы не включены.",
  fields: [number("minRent", "Аренда от, €", 0, 0, 20000),
    number("maxRent", "Аренда до, €", 1500, 500, 2500, 100, false, "query"), area],
  query(url, f) {
    url.searchParams.set("city", "Groningen");
    url.searchParams.set("type", "");
    url.searchParams.set("max", String(f.maxRent));
    return url;
  },
  matches(f, item) { return item.rentPrice !== undefined && item.rentPrice >= f.minRent; },
};
