'use strict';
const core=require('./pararius-core.cjs');
const {main:browserMain}=require('./funda-browser-session.cjs');
let previousFailure;
function searchReady(html,url){
  try{core.parseSearch(html,url);previousFailure=undefined;return true}
  catch(error){
    const diagnostic={category:error instanceof core.FundaError?error.category:'VALIDATION_FAILED',...(error.diagnostic??{})};
    const key=JSON.stringify(diagnostic);
    if(key!==previousFailure){console.log(JSON.stringify({message:'Pararius search validation',...diagnostic}));previousFailure=key;}
    return false;
  }
}
function main(){return browserMain({core,name:'Pararius',homeUrl:'https://www.pararius.nl/',
  navigationDomains:['www.pararius.nl','pararius.nl'],listingSelector:'a.listing-search-item__link--title',searchReady,
  enforceCollectionUrl:true,blockThirdPartyDuringCollection:true,navigationTimeout:30000,logProgress:true});}
module.exports={main,searchReady};
if(require.main===module)main().catch(()=>{console.log('PARARIUS_BROWSER_STARTUP_FAILED');process.exit(1)});
