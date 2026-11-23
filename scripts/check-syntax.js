// Syntax-checks every tracked JavaScript file (node --check) and shell script (sh -n).
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const files = execFileSync('git', ['ls-files', '*.js', '*.sh'], { cwd: root }).toString().trim().split('\n').filter(Boolean);
let failed = 0;
for (const f of files) {
  try {
    if (f.endsWith('.sh')) execFileSync('sh', ['-n', f], { cwd: root, stdio: 'pipe' });
    // Browser code under public/ is ES modules; server and tests are CommonJS.
    else if (f.startsWith('public/')) execFileSync(process.execPath, ['--input-type=module', '--check'], { cwd: root, stdio: 'pipe', input: fs.readFileSync(path.join(root, f)) });
    else execFileSync(process.execPath, ['--check', f], { cwd: root, stdio: 'pipe' });
  } catch (err) {
    failed++;
    console.error(`FAIL ${f}\n${err.stderr || err.message}`);
  }
}
console.log(`syntax: ${files.length - failed}/${files.length} files ok`);
process.exit(failed ? 1 : 0);
