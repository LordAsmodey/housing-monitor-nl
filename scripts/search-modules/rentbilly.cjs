"use strict";
const {rent, area} = require('./fields.cjs');
module.exports = {
  key:'rentbilly', id:'rentbilly:groningen-apartments-studios', name:'RentBilly',
  note:'Groningen, квартиры и студии, до €1500/месяц, от 20 м². Без ограничения даты публикации; описания проверяются на комнаты и общие удобства.',
  fields:[...rent(0,1500), {...area,value:20,stage:'query'}],
  query(url,f) { url.searchParams.set('rent', `${f.minRent}-${f.maxRent}`);
    if(f.minArea === null) url.searchParams.delete('size'); else url.searchParams.set('size',String(f.minArea));
    return url; },
  matches(f,item) { return item.rentPrice !== undefined && item.rentPrice >= f.minRent && item.rentPrice <= f.maxRent; },
};
