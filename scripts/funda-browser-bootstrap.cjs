'use strict';
// Produce a Railway start command from versioned code, never from environment secrets.
const fs=require('node:fs');
const path=require('node:path');
function bundle(file) {
  const code=fs.readFileSync(file,'utf8').replace(/require\('(\.\/[^']+\.cjs)'\)/g,(_match,relative)=>bundle(path.resolve(path.dirname(file),relative)));
  return '(()=>{const module={exports:{}};'+code+';return module.exports})()';
}
const bundled=bundle(path.join(__dirname,'funda-browser-session.cjs'))+'.main();';
const encoded=Buffer.from(bundled).toString('base64');
process.stdout.write(`node -e "eval(Buffer.from('${encoded}','base64').toString())"\n`);
