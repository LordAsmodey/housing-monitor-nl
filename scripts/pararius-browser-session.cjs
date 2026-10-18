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
const fs=require('node:fs/promises');
const {restoreProfile,saveProfile}=require('./browser-profile.cjs');
async function launchProfile({stateKey,directory,saved}) {
  const profile=await fs.mkdtemp('/tmp/pararius-chrome-');
  const archiveFile=directory+'/chrome-profile.enc';
  const restored=await restoreProfile(profile,archiveFile,stateKey);
  const {chromium}=require('patchright');
  let context;
  try {
    context=await chromium.launchPersistentContext(profile,{channel:'chrome',headless:false,viewport:null,args:['--window-size=1024,768']});
    // Retain session cookies when migrating from Chromium and after Chrome's clean close.
    if(saved?.cookies)await context.addCookies(saved.cookies);
  } catch(error) {
    await context?.close();await fs.rm(profile,{recursive:true,force:true});throw error;
  }
  return {browser:context.browser(),context,restored,async close(){
    await context.close();await saveProfile(profile,archiveFile,stateKey);await fs.rm(profile,{recursive:true,force:true});
  }};
}
async function main(){
  const release=(await fs.readFile('/app/REVISION','utf8')).trim();
  if(!/^[a-f0-9]{40}$/.test(release))throw Error('RELEASE_INVALID');
  return browserMain({core,name:'Pararius',engine:'patchright-chrome',release,homeUrl:'https://www.pararius.nl/',
    navigationDomains:['www.pararius.nl','pararius.nl'],listingSelector:'a.listing-search-item__link--title',searchReady,
    reuseFreshSearch:true,enforceCollectionUrl:true,blockThirdPartyDuringCollection:false,navigationTimeout:30000,collectionSettleMs:5000,logProgress:true,
    launchBrowser:launchProfile});
}
module.exports={main,searchReady,launchProfile};
if(require.main===module)main().catch(()=>{console.log('PARARIUS_BROWSER_STARTUP_FAILED');process.exit(1)});
