"use strict";
const { rent, area } = require("./fields.cjs");
module.exports = {
  key: "gruno",
  id: "gruno:groningen-apartments-studios-1500",
  name: "Gruno",
  note: "Groningen, квартиры и самостоятельные студии. Комнаты и несамостоятельное жильё исключены. Цена — объявленная; расходы повторно не прибавляются.",
  fields: [...rent(0, 1500, "server"), area],
  query(url) {
    return url;
  },
  matches(f, item) {
    return (
      item.rentPrice !== undefined &&
      item.rentPrice >= f.minRent &&
      item.rentPrice <= f.maxRent
    );
  },
};
