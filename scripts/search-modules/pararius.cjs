"use strict";
const { rent, area } = require('./fields.cjs');
module.exports = {
  key: 'pararius', id: 'pararius:groningen-25km-homes', name: 'Pararius',
  note: 'Groningen +25 км, квартиры, студии и дома без комнат. Объявленная аренда до €1500/месяц, без ограничения даты. Цена и площадь сужают исходный поиск.',
  fields: [...rent(0, 1500, 'server').map(f => ({...f, max:1500})), area],
  query(url) { return url; },
  matches(f, item) { return item.rentPrice !== undefined && item.rentPrice >= f.minRent && item.rentPrice <= f.maxRent; },
};
