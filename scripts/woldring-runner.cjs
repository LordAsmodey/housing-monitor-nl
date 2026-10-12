'use strict';
const {runFunda}=require('./funda-runner.cjs');
const core=require('./woldring-core.cjs');
const definition={...core,SEARCH_URL:core.SEARCH_URLS[0],searchUrls:core.SEARCH_URLS,
  name:'Woldring — квартиры и студии',baseUrl:'https://woldringverhuur.nl',allowedDomains:['woldringverhuur.nl']};
function runWoldring(db,listings,options={}) {
  return runFunda(db,listings,{...options,collector:options.collector??core.collect,definition});
}
module.exports={runWoldring};
