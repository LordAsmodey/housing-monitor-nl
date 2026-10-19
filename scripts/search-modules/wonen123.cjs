"use strict";
const { rent, area } = require('./fields.cjs');
module.exports = {
  key: 'wonen123', id: '123wonen:groningen-homes', name: '123Wonen',
  note: 'Groningen, отдельное жильё без комнат, до €1500/месяц. Цена и площадь проверяются перед уведомлением. Без ограничения даты публикации.',
  fields: [...rent(0, 1500, 'server'), area],
  query(url) { return url; },
  matches(f, item) { return item.rentPrice !== undefined && item.rentPrice >= f.minRent && item.rentPrice <= f.maxRent; },
};
