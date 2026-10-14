'use strict';
const {runFunda}=require('./funda-runner.cjs');
const core=require('./gruno-core.cjs');
const definition={...core,SEARCH_URL:core.SEARCH_URL,
  name:'Gruno — Groningen, квартиры и студии до €1500',baseUrl:'https://www.grunoverhuur.nl',allowedDomains:['www.grunoverhuur.nl']};
function runGruno(db,listings,options={}) {
  return runFunda(db,listings,{...options,collector:options.collector??core.collect,definition});
}
module.exports={runGruno};
