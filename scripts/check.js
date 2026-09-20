'use strict';
const { readdirSync } = require('node:fs');
const { spawnSync } = require('node:child_process');
for (const file of readdirSync('src').filter((file) => file.endsWith('.js'))) {
  const result = spawnSync(process.execPath, ['--check', `src/${file}`], { stdio: 'inherit' });
  if (result.status !== 0) process.exit(result.status || 1);
}
