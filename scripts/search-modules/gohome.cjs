"use strict";
const { rent, area } = require("./fields.cjs");
module.exports = {
  key: "gohome",
  id: "gohome:groningen-homes",
  name: "GoHome",
  note: "Groningen, отдельное жильё, аренда €500–1500/месяц, без ограничения даты публикации. Цена передаётся в поиск сайта, площадь проверяется перед уведомлением. Пустое поле означает отсутствие ограничения.",
  fields: [...rent(500, 1500), area],
  query(url, f) {
    url.searchParams.set("city", "Groningen");
    url.searchParams.set("f", Buffer.from(JSON.stringify({location:"Groningen",minPrice:f.minRent,maxPrice:f.maxRent})).toString("base64url"));
    return url;
  },
  matches(f, item) {
    if (
      f.minRent > 0 &&
      (item.rentPrice === undefined || item.rentPrice < f.minRent)
    )
      return false;
    if (
      f.maxRent !== null &&
      (item.rentPrice === undefined || item.rentPrice > f.maxRent)
    )
      return false;
    return true;
  },
};
