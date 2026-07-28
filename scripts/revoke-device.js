#!/usr/bin/env node
import { db } from "../services/db.js";

const deviceId = process.argv[2];
if (!deviceId) {
  console.error("Uso: npm run device:revoke -- DEV-...");
  process.exit(1);
}

if (!db.revokeDevice(deviceId)) {
  console.error("Dispositivo ativo não encontrado.");
  process.exit(1);
}

console.log(`Dispositivo revogado: ${deviceId}`);
console.log("Emita outro token para o mesmo usuário com:");
console.log("  npm run pairing:issue -- --user USR-... --hours 24");
