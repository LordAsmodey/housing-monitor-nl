"use strict";
const { rent, area } = require("./fields.cjs");
module.exports = {
  key: "lamberink",
  id: "lamberink:rental-homes",
  name: "Lamberink",
  note: "Дома и квартиры во всех городах, без гаражей. Фильтры применяются после чтения полного каталога. Пустое поле означает отсутствие ограничения.",
  fields: [...rent(0, null, "server"), area],
  query(url) {
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
