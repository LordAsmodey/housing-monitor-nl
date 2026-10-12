'use strict';
const {runFunda}=require('./funda-runner.cjs');
const core=require('./huurwoningen-core.cjs');
const definition={...core,BROWSER_SCENARIO:'railway:huurwoningen-browser-session:encrypted-volume:v1',
  name:'Huurwoningen — Groningen +25 km',baseUrl:'https://www.huurwoningen.com',allowedDomains:['www.huurwoningen.com']};
function runHuurwoningen(db,listings,options={}) {
  return runFunda(db,listings,{...options,collector:options.collector??core.collect,browser:true,definition});
}
module.exports={runHuurwoningen};
