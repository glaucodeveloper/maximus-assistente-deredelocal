import {readFile} from 'node:fs/promises';

const files = ['src/main.js'];
let failed = false;

for (const file of files) {
  const source = await readFile(new URL(`../${file}`, import.meta.url), 'utf8');
  const checks = [
    ['generator component', /function\*\s+\w+Component/],
    ['state patch through yield', /Object\.assign\([\s\S]*?this\.state[\s\S]*?yield/],
    ['element.component binding', /element\.component\s*=\s*this/],
    ['root replacement', /this\.element\?\.isConnected/],
    ['inline template creation', /Object\.assign\(document\.createElement\(['"]template['"]\)/],
  ];

  for (const [name, pattern] of checks) {
    if (!pattern.test(source)) {
      console.error(`${file}: missing ${name}`);
      failed = true;
    }
  }
}

if (failed) process.exit(1);
console.log('Static Next component contract validated.');
