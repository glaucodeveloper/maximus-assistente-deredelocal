import {access, readFile} from 'node:fs/promises';
import {resolve} from 'node:path';

const failures = [];
const warnings = [];
const major = Number(process.versions.node.split('.')[0]);

if (major < 22) failures.push(`Node.js ${process.versions.node} não é suportado. Use Node 22 ou mais recente.`);

try {
  const lock = await readFile(resolve('package-lock.json'), 'utf8');
  if (lock.includes('applied-caas-gateway') || lock.includes('internal.api.openai.org')) {
    failures.push('package-lock.json contém um registry interno inválido.');
  }
} catch {
  warnings.push('package-lock.json não encontrado; use npm install em vez de npm ci.');
}

try {
  const config = JSON.parse(await readFile(resolve('public/app-config.json'), 'utf8'));
  if (String(config?.repository?.owner || '').startsWith('SEU_')) {
    warnings.push('Edite public/app-config.json antes de publicar: owner ainda é um placeholder.');
  }
} catch {
  failures.push('public/app-config.json está ausente ou contém JSON inválido.');
}

try {
  await access(resolve('node_modules/@litert-lm/core/wasm'));
} catch {
  warnings.push('Dependências ainda não instaladas. Execute npm ci --registry=https://registry.npmjs.org.');
}

for (const warning of warnings) console.warn(`AVISO: ${warning}`);
for (const failure of failures) console.error(`ERRO: ${failure}`);
if (failures.length) process.exitCode = 1;
else console.log(`Ambiente Node.js ${process.versions.node} e arquivos do projeto verificados.`);
