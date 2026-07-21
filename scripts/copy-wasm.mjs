import {access, cp, mkdir, rm} from 'node:fs/promises';
import {resolve} from 'node:path';

const source = resolve('node_modules/@litert-lm/core/wasm');
const destination = resolve('public/wasm');

try {
  await access(source);
} catch (error) {
  throw new Error(
    'Os arquivos Wasm do LiteRT-LM não foram encontrados. As dependências provavelmente não foram instaladas. ' +
    'Execute: rm -rf node_modules && npm install --registry=https://registry.npmjs.org',
    {cause: error},
  );
}

await rm(destination, {recursive: true, force: true});
await mkdir(destination, {recursive: true});
await cp(source, destination, {recursive: true});
console.log('LiteRT-LM Wasm files copied to public/wasm.');
