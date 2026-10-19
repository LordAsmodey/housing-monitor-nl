"use strict";
const { rent, area } = require('./fields.cjs');
module.exports = {
  key: 'rotsvast', id: 'rotsvast:groningen-homes', name: 'Rotsvast',
  note: 'Groningen, отдельное жильё без комнат, до €1500/месяц. Без ограничения даты публикации. Тип жилья проверяется по деталям.',
  fields: [...rent(0, 1500, 'server'), area],
  query(url, f) { url.searchParams.set('price_to', String(f.maxRent)); return url; },
  matches(f, item) { return item.rentPrice !== undefined && item.rentPrice >= f.minRent && item.rentPrice <= f.maxRent; },
};
