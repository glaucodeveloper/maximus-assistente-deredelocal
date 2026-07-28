import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { resolve, dirname } from "node:path";
import { mkdirSync } from "node:fs";

const dbPath = resolve(process.env.ENGINEERING_DB_PATH || "okf/db.sqlite");
mkdirSync(dirname(dbPath), { recursive: true });

const database = new DatabaseSync(dbPath);
database.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;
  PRAGMA busy_timeout = 5000;

  CREATE TABLE IF NOT EXISTS users (
    mac TEXT PRIMARY KEY,
    ip TEXT NOT NULL,
    name TEXT NOT NULL,
    role TEXT NOT NULL,
    sector TEXT NOT NULL,
    registered_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS permissions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    requester_mac TEXT NOT NULL,
    target_username TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending'
      CHECK(status IN ('pending', 'approved', 'rejected')),
    requested_at TEXT NOT NULL,
    FOREIGN KEY(requester_mac) REFERENCES users(mac)
  );

  CREATE TABLE IF NOT EXISTS tasks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    description TEXT NOT NULL,
    assigned_to_mac TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending'
      CHECK(status IN ('pending', 'in_progress', 'completed')),
    created_at TEXT NOT NULL,
    FOREIGN KEY(assigned_to_mac) REFERENCES users(mac)
  );

  CREATE TABLE IF NOT EXISTS documents (
    path TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    description TEXT NOT NULL,
    tags TEXT NOT NULL,
    author_name TEXT NOT NULL,
    author_role TEXT NOT NULL,
    source_file TEXT NOT NULL,
    uploaded_by_mac TEXT NOT NULL,
    uploaded_at TEXT NOT NULL,
    FOREIGN KEY(uploaded_by_mac) REFERENCES users(mac)
  );

  CREATE TABLE IF NOT EXISTS pairing_tokens (
    id TEXT PRIMARY KEY,
    token_hash TEXT NOT NULL UNIQUE,
    user_mac TEXT,
    expires_at TEXT NOT NULL,
    used_at TEXT,
    revoked_at TEXT,
    created_at TEXT NOT NULL,
    note TEXT NOT NULL DEFAULT '',
    FOREIGN KEY(user_mac) REFERENCES users(mac)
  );

  CREATE TABLE IF NOT EXISTS devices (
    id TEXT PRIMARY KEY,
    user_mac TEXT NOT NULL,
    machine_address TEXT NOT NULL UNIQUE,
    token_hash TEXT NOT NULL UNIQUE,
    label TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'active'
      CHECK(status IN ('active', 'revoked')),
    paired_at TEXT NOT NULL,
    last_seen_at TEXT NOT NULL,
    last_ip TEXT NOT NULL,
    revoked_at TEXT,
    FOREIGN KEY(user_mac) REFERENCES users(mac)
  );

  CREATE INDEX IF NOT EXISTS idx_devices_token_hash
    ON devices(token_hash);

  CREATE INDEX IF NOT EXISTS idx_devices_user_mac
    ON devices(user_mac);

  CREATE INDEX IF NOT EXISTS idx_devices_last_ip
    ON devices(last_ip);

  CREATE INDEX IF NOT EXISTS idx_permissions_target
    ON permissions(target_username, status);
`);

function normalizeIp(value) {
  const normalized = String(value || "").trim().replace(/^::ffff:/, "");
  return normalized === "::1" ? "127.0.0.1" : normalized;
}

function normalizeMachineAddress(value) {
  const normalized = String(value || "").trim().toLowerCase();
  if (!normalized) throw new Error("Não foi possível identificar o endereço da máquina.");
  if (normalized.startsWith("local:") && /^local:[a-f0-9]{24,64}$/.test(normalized)) {
    return normalized;
  }
  if (!/^([a-f0-9]{2}:){5}[a-f0-9]{2}$/.test(normalized)) {
    throw new Error("Endereço físico da máquina inválido.");
  }
  if (normalized === "00:00:00:00:00:00" || normalized === "ff:ff:ff:ff:ff:ff") {
    throw new Error("O endereço físico da máquina não é utilizável.");
  }
  return normalized;
}

function hashToken(token) {
  return createHash("sha256").update(String(token || ""), "utf8").digest("hex");
}

function randomToken(prefix) {
  return `${prefix}_${randomBytes(32).toString("base64url")}`;
}

function constantTimeTextEqual(left, right) {
  const a = Buffer.from(String(left || ""));
  const b = Buffer.from(String(right || ""));
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function plainText(value, maxLength = 200) {
  return String(value || "")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/[<>]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength);
}

function folderName(value, fallback = "usuario") {
  const base = String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "")
    .slice(0, 40);
  return base || fallback;
}

function accountFolder(user) {
  return folderName(user?.name, "usuario");
}

function getUserByMac(mac) {
  const stmt = database.prepare("SELECT * FROM users WHERE mac = ?");
  return stmt.get(String(mac || "")) || null;
}

function createOrUpdateUser({ mac, ip, name, role, sector }) {
  const safeMac = String(mac || "").trim();
  if (!safeMac) throw new Error("Identificador do usuário ausente.");

  const safeName = plainText(name, 80);
  const safeRole = plainText(role, 80);
  const safeSector = plainText(sector, 80);
  if (!safeName || !safeRole || !safeSector) {
    throw new Error("Nome, função e setor são obrigatórios.");
  }

  const stmt = database.prepare(`
    INSERT INTO users (mac, ip, name, role, sector, registered_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(mac) DO UPDATE SET
      ip = excluded.ip,
      name = excluded.name,
      role = excluded.role,
      sector = excluded.sector
  `);
  stmt.run(
    safeMac,
    normalizeIp(ip),
    safeName,
    safeRole,
    safeSector,
    new Date().toISOString(),
  );
  return getUserByMac(safeMac);
}

function transaction(operation) {
  database.exec("BEGIN IMMEDIATE");
  try {
    const result = operation();
    database.exec("COMMIT");
    return result;
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

function userWithDevice(userMac, device) {
  const user = getUserByMac(userMac);
  if (!user) return null;
  return {
    ...user,
    folder: accountFolder(user),
    deviceId: device.id,
    deviceAddress: device.machine_address,
    deviceLabel: device.label,
    lastIp: device.last_ip,
  };
}

export const db = {
  databasePath: dbPath,

  createUser(input) {
    return createOrUpdateUser(input);
  },

  getUserByMac,

  getUserByIp(ip) {
    const normalizedIp = normalizeIp(ip);
    const row = database.prepare(`
      SELECT u.*
      FROM devices d
      JOIN users u ON u.mac = d.user_mac
      WHERE d.last_ip = ? AND d.status = 'active'
      ORDER BY d.last_seen_at DESC
      LIMIT 1
    `).get(normalizedIp);
    return row || null;
  },

  getUserByUsername(username) {
    const normalized = folderName(username);
    const users = database.prepare("SELECT * FROM users ORDER BY registered_at ASC").all();
    return users.find(user => accountFolder(user) === normalized) || null;
  },

  listUsers() {
    return database.prepare(`
      SELECT
        u.*,
        (
          SELECT d.machine_address
          FROM devices d
          WHERE d.user_mac = u.mac AND d.status = 'active'
          ORDER BY d.last_seen_at DESC
          LIMIT 1
        ) AS device_address
      FROM users u
      ORDER BY u.name ASC
    `).all().map(user => ({ ...user, folder: accountFolder(user) }));
  },

  updateUserIp(mac, ip) {
    database.prepare("UPDATE users SET ip = ? WHERE mac = ?")
      .run(normalizeIp(ip), String(mac || ""));
  },

  createPairingToken({ userMac = null, expiresHours = 24, note = "" } = {}) {
    const boundUser = userMac ? getUserByMac(userMac) : null;
    if (userMac && !boundUser) {
      throw new Error(`Usuário não encontrado: ${userMac}`);
    }

    const hours = Math.max(1, Math.min(168, Number(expiresHours) || 24));
    const token = randomToken("mxp");
    const now = new Date();
    const expiresAt = new Date(now.getTime() + hours * 60 * 60 * 1000);

    database.prepare(`
      INSERT INTO pairing_tokens (
        id, token_hash, user_mac, expires_at, created_at, note
      ) VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      randomUUID(),
      hashToken(token),
      boundUser?.mac || null,
      expiresAt.toISOString(),
      now.toISOString(),
      plainText(note, 200),
    );

    return {
      token,
      user: boundUser,
      expiresAt: expiresAt.toISOString(),
    };
  },

  pairDevice({
    pairingToken,
    machineAddress,
    ip,
    name,
    role,
    sector,
    label = "",
  }) {
    const normalizedAddress = normalizeMachineAddress(machineAddress);
    const normalizedIp = normalizeIp(ip);
    const presentedHash = hashToken(pairingToken);

    return transaction(() => {
      const tokenRow = database.prepare(`
        SELECT *
        FROM pairing_tokens
        WHERE token_hash = ?
      `).get(presentedHash);

      if (!tokenRow || tokenRow.revoked_at || tokenRow.used_at) {
        throw new Error("Token de pareamento inválido, já usado ou revogado.");
      }
      if (Date.parse(tokenRow.expires_at) <= Date.now()) {
        throw new Error("O token de pareamento expirou.");
      }

      let user;
      if (tokenRow.user_mac) {
        user = getUserByMac(tokenRow.user_mac);
        if (!user) throw new Error("O usuário associado ao token não existe.");
        createOrUpdateUser({
          mac: user.mac,
          ip: normalizedIp,
          name: name || user.name,
          role: role || user.role,
          sector: sector || user.sector,
        });
        user = getUserByMac(user.mac);
      } else {
        user = createOrUpdateUser({
          mac: `USR-${randomUUID()}`,
          ip: normalizedIp,
          name,
          role,
          sector,
        });
      }

      const accessToken = randomToken("mxd");
      const now = new Date().toISOString();
      const deviceId = `DEV-${randomUUID()}`;

      database.prepare(`
        INSERT INTO devices (
          id, user_mac, machine_address, token_hash, label, status,
          paired_at, last_seen_at, last_ip, revoked_at
        ) VALUES (?, ?, ?, ?, ?, 'active', ?, ?, ?, NULL)
        ON CONFLICT(machine_address) DO UPDATE SET
          id = excluded.id,
          user_mac = excluded.user_mac,
          token_hash = excluded.token_hash,
          label = excluded.label,
          status = 'active',
          paired_at = excluded.paired_at,
          last_seen_at = excluded.last_seen_at,
          last_ip = excluded.last_ip,
          revoked_at = NULL
      `).run(
        deviceId,
        user.mac,
        normalizedAddress,
        hashToken(accessToken),
        plainText(label || user.name, 80),
        now,
        now,
        normalizedIp,
      );

      database.prepare(`
        UPDATE pairing_tokens
        SET used_at = ?
        WHERE id = ?
      `).run(now, tokenRow.id);

      const device = database.prepare(
        "SELECT * FROM devices WHERE machine_address = ?",
      ).get(normalizedAddress);

      return {
        accessToken,
        user: userWithDevice(user.mac, device),
        device,
      };
    });
  },

  authenticateDevice({ accessToken, machineAddress, ip }) {
    const token = String(accessToken || "").trim();
    if (!token.startsWith("mxd_") || token.length < 40) return null;

    let normalizedAddress;
    try {
      normalizedAddress = normalizeMachineAddress(machineAddress);
    } catch {
      return null;
    }

    const device = database.prepare(`
      SELECT *
      FROM devices
      WHERE token_hash = ? AND status = 'active'
      LIMIT 1
    `).get(hashToken(token));

    if (!device || !constantTimeTextEqual(device.machine_address, normalizedAddress)) {
      return null;
    }

    const normalizedIp = normalizeIp(ip);
    const now = new Date().toISOString();
    database.prepare(`
      UPDATE devices
      SET last_seen_at = ?, last_ip = ?
      WHERE id = ?
    `).run(now, normalizedIp, device.id);
    database.prepare("UPDATE users SET ip = ? WHERE mac = ?")
      .run(normalizedIp, device.user_mac);

    return userWithDevice(device.user_mac, {
      ...device,
      last_seen_at: now,
      last_ip: normalizedIp,
    });
  },

  listDevices() {
    return database.prepare(`
      SELECT
        d.*,
        u.name AS user_name,
        u.role AS user_role,
        u.sector AS user_sector
      FROM devices d
      JOIN users u ON u.mac = d.user_mac
      ORDER BY d.last_seen_at DESC
    `).all();
  },

  revokeDevice(deviceId) {
    const now = new Date().toISOString();
    const result = database.prepare(`
      UPDATE devices
      SET status = 'revoked', revoked_at = ?, token_hash = ?
      WHERE id = ? AND status = 'active'
    `).run(now, hashToken(`revoked:${deviceId}:${now}:${randomUUID()}`), String(deviceId || ""));
    return Number(result.changes || 0) > 0;
  },

  revokePairingToken(tokenOrId) {
    const value = String(tokenOrId || "").trim();
    const now = new Date().toISOString();
    const result = value.startsWith("mxp_")
      ? database.prepare(`
          UPDATE pairing_tokens SET revoked_at = ?
          WHERE token_hash = ? AND used_at IS NULL AND revoked_at IS NULL
        `).run(now, hashToken(value))
      : database.prepare(`
          UPDATE pairing_tokens SET revoked_at = ?
          WHERE id = ? AND used_at IS NULL AND revoked_at IS NULL
        `).run(now, value);
    return Number(result.changes || 0) > 0;
  },

  createPermissionRequest({ requesterMac, targetUsername }) {
    const target = folderName(targetUsername);
    const existing = database.prepare(`
      SELECT id FROM permissions
      WHERE requester_mac = ? AND target_username = ? AND status = 'pending'
      LIMIT 1
    `).get(requesterMac, target);
    if (existing) return existing.id;

    const result = database.prepare(`
      INSERT INTO permissions (
        requester_mac, target_username, status, requested_at
      ) VALUES (?, ?, 'pending', ?)
    `).run(requesterMac, target, new Date().toISOString());
    return Number(result.lastInsertRowid);
  },

  checkPermission(requesterMac, targetUsername) {
    return database.prepare(`
      SELECT * FROM permissions
      WHERE requester_mac = ?
        AND target_username = ?
        AND status = 'approved'
      ORDER BY requested_at DESC
      LIMIT 1
    `).get(requesterMac, folderName(targetUsername)) || null;
  },

  listPendingPermissions() {
    return database.prepare(`
      SELECT p.*, u.name AS requester_name, u.role AS requester_role,
             u.sector AS requester_sector
      FROM permissions p
      JOIN users u ON p.requester_mac = u.mac
      WHERE p.status = 'pending'
      ORDER BY p.requested_at DESC
    `).all();
  },

  listPendingPermissionsForOwner(targetUsername) {
    return database.prepare(`
      SELECT p.*, u.name AS requester_name, u.role AS requester_role,
             u.sector AS requester_sector
      FROM permissions p
      JOIN users u ON p.requester_mac = u.mac
      WHERE p.status = 'pending' AND p.target_username = ?
      ORDER BY p.requested_at DESC
    `).all(folderName(targetUsername));
  },

  listAllPermissions() {
    return database.prepare(`
      SELECT p.*, u.name AS requester_name, u.role AS requester_role
      FROM permissions p
      JOIN users u ON p.requester_mac = u.mac
      ORDER BY p.requested_at DESC
    `).all();
  },

  updatePermissionStatus(id, status) {
    const normalizedStatus = String(status || "");
    if (!["approved", "rejected"].includes(normalizedStatus)) {
      throw new Error("Status de permissão inválido.");
    }
    database.prepare("UPDATE permissions SET status = ? WHERE id = ?")
      .run(normalizedStatus, Number(id));
  },

  updatePermissionStatusForOwner(id, status, ownerUsername) {
    const normalizedStatus = String(status || "");
    if (!["approved", "rejected"].includes(normalizedStatus)) {
      throw new Error("Status de permissão inválido.");
    }
    const result = database.prepare(`
      UPDATE permissions
      SET status = ?
      WHERE id = ? AND target_username = ? AND status = 'pending'
    `).run(normalizedStatus, Number(id), folderName(ownerUsername));
    return Number(result.changes || 0) > 0;
  },

  createTask({ title, description, assignedToMac }) {
    if (!getUserByMac(assignedToMac)) throw new Error("Responsável não encontrado.");
    database.prepare(`
      INSERT INTO tasks (
        title, description, assigned_to_mac, status, created_at
      ) VALUES (?, ?, ?, 'pending', ?)
    `).run(
      plainText(title, 160),
      plainText(description, 2000),
      assignedToMac,
      new Date().toISOString(),
    );
  },

  listTasks() {
    return database.prepare(`
      SELECT t.*, u.name AS assigned_to_name, u.role AS assigned_to_role
      FROM tasks t
      JOIN users u ON t.assigned_to_mac = u.mac
      ORDER BY t.created_at DESC
    `).all();
  },

  updateTaskStatus(id, status) {
    const normalizedStatus = String(status || "");
    if (!["pending", "in_progress", "completed"].includes(normalizedStatus)) {
      throw new Error("Status de tarefa inválido.");
    }
    database.prepare("UPDATE tasks SET status = ? WHERE id = ?")
      .run(normalizedStatus, Number(id));
  },

  createDocument({
    path,
    title,
    description,
    tags,
    authorName,
    authorRole,
    sourceFile,
    uploadedByMac,
  }) {
    const safeTags = (Array.isArray(tags) ? tags : [])
      .map(tag => plainText(tag, 60))
      .filter(Boolean)
      .slice(0, 16);

    database.prepare(`
      INSERT INTO documents (
        path, title, description, tags, author_name, author_role,
        source_file, uploaded_by_mac, uploaded_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(path) DO UPDATE SET
        title = excluded.title,
        description = excluded.description,
        tags = excluded.tags,
        author_name = excluded.author_name,
        author_role = excluded.author_role,
        source_file = excluded.source_file,
        uploaded_by_mac = excluded.uploaded_by_mac,
        uploaded_at = excluded.uploaded_at
    `).run(
      String(path || "").slice(0, 500),
      plainText(title, 180),
      plainText(description, 500),
      JSON.stringify(safeTags),
      plainText(authorName, 80),
      plainText(authorRole, 80),
      plainText(sourceFile, 200),
      uploadedByMac,
      new Date().toISOString(),
    );
  },

  listDocuments() {
    return database.prepare(
      "SELECT * FROM documents ORDER BY uploaded_at DESC",
    ).all().map(doc => ({
      ...doc,
      tags: JSON.parse(doc.tags || "[]"),
    }));
  },
};

export {
  accountFolder,
  folderName,
  normalizeIp,
  normalizeMachineAddress,
};
