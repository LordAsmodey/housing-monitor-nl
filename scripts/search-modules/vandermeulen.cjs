"use strict";
const { rent, area } = require("./fields.cjs");
module.exports = {
  key: "vandermeulen",
  id: "vandermeulen:groningen-nieuw",
  name: "Van der Meulen",
  note: "Groningen, статус Nieuw. Цена передаётся в поиск сайта, минимальная площадь проверяется перед уведомлением.",
  fields: [...rent(10, 1500), area],
  query(url, f) {
    url.searchParams.set("_plaats", "groningen");
    url.searchParams.set("_status", "nieuw");
    url.searchParams.set("_prijsbereik", `${f.minRent.toFixed(2)},${f.maxRent.toFixed(2)}`);
    return url;
  },
};
