const fs = require('fs');
const path = 'package.json';
const pkg = JSON.parse(fs.readFileSync(path,'utf8'));

pkg.scripts ||= {};
// If you already have a proper "test" (jest/vitest/mocha etc.), we keep it.
// If it's missing, we add a harmless placeholder so CI doesn't fail.
if (!pkg.scripts.test) {
  pkg.scripts.test = 'echo "No tests yet" && exit 0';
}
// Add test:ci alias to call the regular test script.
pkg.scripts['test:ci'] ||= 'npm test';

fs.writeFileSync(path, JSON.stringify(pkg, null, 2) + '\n');
console.log('✅ Updated scripts:', pkg.scripts);
