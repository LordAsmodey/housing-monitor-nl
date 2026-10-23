'use strict';
const {rent, area} = require('./fields.cjs');
module.exports = {
  key:'ikwilhuren', id:'ikwilhuren:groningen-30km-homes', name:'ikwilhuren.nu',
  note:'Groningen +30 км по координатам сайта. Отдельное жильё до €1500/месяц, без ограничения даты публикации. Фильтры применяются локально.',
  fields:[...rent(0,1500,'server'),area], query(url) { return url; },
  matches(f,item) { return item.rentPrice !== undefined && item.rentPrice >= f.minRent && item.rentPrice <= f.maxRent; },
};
