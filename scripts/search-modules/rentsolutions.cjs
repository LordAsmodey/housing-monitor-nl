"use strict";
const { rent, area } = require("./fields.cjs");
module.exports = {
  key: "rentsolutions",
  id: "rentsolutions:groningen",
  name: "Rent Solutions",
  note: "Groningen, все типы жилья, аренда до €1500/месяц, без ограничения даты публикации. Цена передаётся в поиск сайта, площадь проверяется перед уведомлением. Пустое поле означает отсутствие ограничения.",
  fields: [...rent(0, 1500), area],
  query(url, f) {
    url.searchParams.set("_plaats", "groningen");
    url.searchParams.set("_price", `${f.minRent},${f.maxRent}`);
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
