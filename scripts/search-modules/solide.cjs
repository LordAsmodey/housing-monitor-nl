"use strict";
const { rent, area } = require("./fields.cjs");
module.exports = {
  key: "solide", id: "solide:groningen-rental", name: "Solide Verhuur",
  note: "Groningen. Цена передаётся в поиск сайта; минимальная площадь проверяется сервером. Уведомления только для доступных объектов.",
  fields: [...rent(0, 1500), area],
  query(url, f) {
    if (f.minRent) url.searchParams.set("property_price_from", String(f.minRent));
    else url.searchParams.delete("property_price_from");
    url.searchParams.set("property_price_to", String(f.maxRent));
    return url;
  },
};
