import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const roots = ["server.js", "vite.config.js", "services", "scripts", "test", "public/app.js", "src/client"];
const files = [];

function collect(path) {
  const stat = statSync(path);
  if (stat.isFile() && /\.(?:js|mjs)$/.test(path)) {
    files.push(path);
    return;
  }
  if (!stat.isDirectory()) return;
  for (const name of readdirSync(path)) {
    collect(join(path, name));
  }
}

for (const root of roots) {
  try {
    collect(root);
  } catch {
    // Raiz opcional.
  }
}

let failed = false;
for (const file of files) {
  const result = spawnSync(process.execPath, ["--check", file], {
    encoding: "utf8",
  });
  if (result.status !== 0) {
    failed = true;
    process.stderr.write(result.stderr || result.stdout);
  }
}

if (failed) process.exit(1);
console.log(`Sintaxe validada em ${files.length} arquivos JavaScript.`);
