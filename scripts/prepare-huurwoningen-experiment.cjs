'use strict';
// Export only committed, explicitly listed files. Never upload .env or the checkout.
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
function prepare(target) {
  if (!target || !path.isAbsolute(target) || fs.existsSync(target)) throw Error('NEW_ARTIFACT_DIRECTORY_REQUIRED');
  const root = path.resolve(__dirname, '..');
  const git = args => execFileSync('git', args, { cwd: root, encoding: 'utf8' });
  const revision = git(['rev-parse', 'HEAD']).trim();
  const files = ['Dockerfile.huurwoningen-experiment', 'browser-experiment/package.json', 'browser-experiment/package-lock.json',
    ...['browser-lifecycle', 'browser-resources', 'funda-core', 'funda-browser-session', 'huurwoningen-core', 'huurwoningen-browser-session', 'browser-profile', 'huurwoningen-experiment', 'huurwoningen-patchright-session'].map(name => 'scripts/' + name + '.cjs')];
  fs.mkdirSync(target, { recursive: true, mode: 0o700 });
  for (const file of files) {
    const dest = path.join(target, file === 'Dockerfile.huurwoningen-experiment' ? 'Dockerfile' : file);
    fs.mkdirSync(path.dirname(dest), { recursive: true }); fs.writeFileSync(dest, git(['show', revision + ':' + file]));
  }
  fs.writeFileSync(path.join(target, 'browser-experiment/REVISION'), revision + '\n');
  fs.writeFileSync(path.join(target, 'railway.json'), JSON.stringify({ build: { builder: 'DOCKERFILE', dockerfilePath: 'Dockerfile' },
    deploy: { healthcheckPath: '/health', healthcheckTimeout: 180, restartPolicyType: 'ON_FAILURE', restartPolicyMaxRetries: 3 } }, null, 2));
  console.log(JSON.stringify({ artifact: target, revision, files: files.length + 2 }));
}
module.exports = { prepare };
if (require.main === module) prepare(process.argv[2]);
