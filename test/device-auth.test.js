import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const temp = mkdtempSync(join(tmpdir(), "engenharia-auth-"));
process.env.ENGINEERING_DB_PATH = join(temp, "test.sqlite");

const { db } = await import(`../services/db.js?test=${Date.now()}`);

test("token fica vinculado ao endereço da máquina", () => {
  const pairing = db.createPairingToken({ expiresHours: 1 });
  const paired = db.pairDevice({
    pairingToken: pairing.token,
    machineAddress: "02:11:22:33:44:55",
    ip: "192.168.1.10",
    name: "Pessoa de Teste",
    role: "Engenheiro",
    sector: "Projetos",
  });

  assert.ok(paired.accessToken.startsWith("mxd_"));
  assert.equal(
    db.authenticateDevice({
      accessToken: paired.accessToken,
      machineAddress: "02:11:22:33:44:55",
      ip: "192.168.1.11",
    })?.name,
    "Pessoa de Teste",
  );

  assert.equal(
    db.authenticateDevice({
      accessToken: paired.accessToken,
      machineAddress: "02:aa:bb:cc:dd:ee",
      ip: "192.168.1.12",
    }),
    null,
  );

  assert.throws(() => {
    db.pairDevice({
      pairingToken: pairing.token,
      machineAddress: "02:aa:bb:cc:dd:ee",
      ip: "192.168.1.12",
      name: "Invasor",
      role: "Outro",
      sector: "Outro",
    });
  }, /já usado|inválido|revogado/i);

  assert.equal(db.revokeDevice(paired.device.id), true);
  assert.equal(
    db.authenticateDevice({
      accessToken: paired.accessToken,
      machineAddress: "02:11:22:33:44:55",
      ip: "192.168.1.11",
    }),
    null,
  );
});

test.after(() => {
  rmSync(temp, { recursive: true, force: true });
});
