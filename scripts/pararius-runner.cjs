'use strict';
const {runFunda}=require('./funda-runner.cjs');
const core=require('./pararius-core.cjs');
const definition={...core,BROWSER_SCENARIO:'railway:pararius-browser-session:encrypted-volume:v2-chrome-homes',
  requireAvailable:true,name:'Pararius — Groningen +25 km',baseUrl:'https://www.pararius.nl',allowedDomains:['www.pararius.nl']};
function runPararius(db,listings,options={}) {
  return runFunda(db,listings,{...options,collector:options.collector??core.collect,browser:true,definition});
}
module.exports={runPararius};
