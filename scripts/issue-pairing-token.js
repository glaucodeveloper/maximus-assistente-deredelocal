#!/usr/bin/env node
import { db } from "../services/db.js";

function argument(name, fallback = null) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] ?? fallback : fallback;
}

const userMac = argument("--user");
const expiresHours = Number(argument("--hours", "24"));
const note = argument("--note", userMac ? "Substituição de dispositivo" : "Novo usuário");

try {
  const result = db.createPairingToken({
    userMac,
    expiresHours,
    note,
  });

  console.log("");
  console.log("TOKEN DE PAREAMENTO — exibido somente agora");
  console.log("------------------------------------------------");
  console.log(result.token);
  console.log("------------------------------------------------");
  console.log(`Expira em: ${result.expiresAt}`);
  console.log(
    result.user
      ? `Usuário existente: ${result.user.name} (${result.user.mac})`
      : "Uso: cadastro inicial de um novo usuário.",
  );
  console.log("");
  console.log("Novo usuário:");
  console.log("  npm run pairing:issue -- --hours 24");
  console.log("");
  console.log("Substituição de máquina:");
  console.log("  npm run pairing:issue -- --user USR-... --hours 24");
} catch (error) {
  console.error(`Erro: ${error.message}`);
  process.exitCode = 1;
}
