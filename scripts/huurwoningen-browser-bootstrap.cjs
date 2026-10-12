'use strict';
// Bundle only versioned local modules; no secrets are embedded in this command.
const fs=require('node:fs');
const path=require('node:path');
function bundle(file) {
  const code=fs.readFileSync(file,'utf8').replace(/require\('(\.\/[^']+\.cjs)'\)/g,(_match,relative)=>bundle(path.resolve(path.dirname(file),relative)));
  return '(()=>{const module={exports:{}};'+code+';return module.exports})()';
}
const code=bundle(path.join(__dirname,'huurwoningen-browser-session.cjs'))+'.main().then(async()=>{if(process.env.BROWSER_SMOKE_ON_START==="true"){await new Promise(r=>setTimeout(r,5000));await '+bundle(path.join(__dirname,'huurwoningen-session-verify.cjs'))+'.verify("http://127.0.0.1:"+(process.env.PORT??8080)).catch(()=>console.log("HUUR_SMOKE_FAILED"))}});';
process.stdout.write(`node -e "eval(Buffer.from('${Buffer.from(code).toString('base64')}','base64').toString())"\n`);
