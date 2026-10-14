'use strict';
const fs = require('node:fs/promises');
async function resources() {
  const result = { nodeRssBytes: process.memoryUsage().rss };
  for (const file of ['/sys/fs/cgroup/memory.current', '/sys/fs/cgroup/memory/memory.usage_in_bytes']) {
    try { const value = Number((await fs.readFile(file, 'utf8')).trim()); if (Number.isSafeInteger(value) && value >= 0) { result.containerMemoryBytes = value; break; } } catch {}
  }
  try {
    const entries = (await fs.readdir('/proc')).filter(name => /^\d+$/.test(name));
    const statuses = await Promise.all(entries.map(pid => fs.readFile('/proc/' + pid + '/status', 'utf8').catch(() => '')));
    result.browserProcesses = statuses.filter(status => /^Name:\s+(chrome|chromium)/m.test(status) && !/^State:\s+Z/m.test(status)).length;
  } catch {}
  return result;
}
module.exports = { resources };
