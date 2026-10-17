'use strict';
const core=require('./pararius-core.cjs');
const {main:browserMain}=require('./funda-browser-session.cjs');
function searchReady(html,url){try{core.parseSearch(html,url);return true}catch{return false}}
function main(){return browserMain({core,name:'Pararius',homeUrl:'https://www.pararius.nl/',
  navigationDomains:['www.pararius.nl','pararius.nl'],listingSelector:'a.listing-search-item__link--title',searchReady,
  enforceCollectionUrl:true,blockThirdPartyDuringCollection:true,navigationTimeout:30000,logProgress:true});}
module.exports={main,searchReady};
if(require.main===module)main().catch(()=>{console.log('PARARIUS_BROWSER_STARTUP_FAILED');process.exit(1)});
