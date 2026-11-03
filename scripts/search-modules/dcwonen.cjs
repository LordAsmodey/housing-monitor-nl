"use strict";
const { rent, area } = require('./fields.cjs');
module.exports = {
  key: 'dcwonen', id: 'dcwonen:groningen-homes', name: 'DC Wonen',
  note: 'Groningen: квартиры, студии и дома, без комнат. Цена карточки (inclusief/exclusief), без вычета коммунальных расходов. Фильтры применяются сервером.',
  fields: [...rent(0, 1500, 'server'), area],
  query(url) { return url; },
  matches(f, x) { return typeof x.rentPrice === 'number' && x.rentPrice >= f.minRent && (f.maxRent === null || x.rentPrice <= f.maxRent); },
};
