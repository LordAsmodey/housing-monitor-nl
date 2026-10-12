'use strict';
const core=require('./huurwoningen-core.cjs');
const {main:browserMain}=require('./funda-browser-session.cjs');
function searchReady(html,url){try{core.parseSearch(html,url);return true}catch{return false}}
function main(){return browserMain({core,name:'Huurwoningen',homeUrl:'https://www.huurwoningen.com/',
  navigationDomains:['www.huurwoningen.com','huurwoningen.com'],listingSelector:'a[href^="/huren/"]',searchReady});}
module.exports={main,searchReady};
if(require.main===module)main().catch(()=>{console.log('HUUR_BROWSER_STARTUP_FAILED');process.exit(1)});
