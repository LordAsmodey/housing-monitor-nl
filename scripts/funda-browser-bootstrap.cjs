'use strict';
// Produce a Railway start command from versioned code, never from environment secrets.
const fs=require('node:fs');
const path=require('node:path');
const core=fs.readFileSync(path.join(__dirname,'funda-core.cjs'),'utf8');
const browser=fs.readFileSync(path.join(__dirname,'funda-browser-session.cjs'),'utf8');
const bundled=browser.replace("require('./funda-core.cjs')",'(()=>{const module={exports:{}};'+core+';return module.exports})()');
const encoded=Buffer.from(bundled+'\nmain();').toString('base64');
process.stdout.write(`node -e "eval(Buffer.from('${encoded}','base64').toString())"\n`);
