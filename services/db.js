import { DatabaseSync } from "node:sqlite";
import { resolve, dirname } from "node:path";
import { mkdirSync } from "node:fs";

const dbPath = resolve("okf/db.sqlite");
mkdirSync(dirname(dbPath), { recursive: true });

const database = new DatabaseSync(dbPath);

// Inicializa as tabelas se não existirem
database.exec(`
  PRAGMA journal_mode = WAL;

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
    status TEXT NOT NULL DEFAULT 'pending',
    requested_at TEXT NOT NULL,
    FOREIGN KEY(requester_mac) REFERENCES users(mac)
  );

  CREATE TABLE IF NOT EXISTS tasks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    description TEXT NOT NULL,
    assigned_to_mac TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    created_at TEXT NOT NULL,
    FOREIGN KEY(assigned_to_mac) REFERENCES users(mac)
  );

  CREATE TABLE IF NOT EXISTS documents (
    path TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    description TEXT NOT NULL,
    tags TEXT NOT NULL, -- JSON String Array
    author_name TEXT NOT NULL,
    author_role TEXT NOT NULL,
    source_file TEXT NOT NULL,
    uploaded_by_mac TEXT NOT NULL,
    uploaded_at TEXT NOT NULL,
    FOREIGN KEY(uploaded_by_mac) REFERENCES users(mac)
  );
`);

export const db = {
  // --- USUÁRIOS ---
  createUser({ mac, ip, name, role, sector }) {
    const stmt = database.prepare(`
      INSERT INTO users (mac, ip, name, role, sector, registered_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(mac) DO UPDATE SET ip = excluded.ip, name = excluded.name, role = excluded.role, sector = excluded.sector
    `);
    stmt.run(mac, ip, name, role, sector, new Date().toISOString());
    return this.getUserByMac(mac);
  },

  getUserByMac(mac) {
    const stmt = database.prepare("SELECT * FROM users WHERE mac = ?");
    return stmt.get(mac) || null;
  },

  getUserByIp(ip) {
    // Normaliza IPv6 loopback ou IPv4 mapeado em IPv6 (::ffff:127.0.0.1)
    const normalizedIp = ip.replace(/^::ffff:/, "");
    if (normalizedIp === "::1" || normalizedIp === "localhost") {
      // Retorna o primeiro usuário caso seja localhost para fins de teste local rápido
      const first = database.prepare("SELECT * FROM users LIMIT 1").get();
      if (first) return first;
    }
    const stmt = database.prepare("SELECT * FROM users WHERE ip = ?");
    return stmt.get(normalizedIp) || null;
  },

  getUserByUsername(username) {
    const stmt = database.prepare("SELECT * FROM users WHERE LOWER(name) = ? OR REPLACE(LOWER(name), ' ', '') = ?");
    return stmt.get(username.toLowerCase(), username.toLowerCase().replace(/[^a-z0-9]+/g, "")) || null;
  },

  listUsers() {
    const stmt = database.prepare("SELECT * FROM users ORDER BY name ASC");
    return stmt.all();
  },

  updateUserIp(mac, ip) {
    const normalizedIp = ip.replace(/^::ffff:/, "");
    const stmt = database.prepare("UPDATE users SET ip = ? WHERE mac = ?");
    stmt.run(normalizedIp, mac);
  },

  // --- PERMISSÕES ---
  createPermissionRequest({ requesterMac, targetUsername }) {
    const stmt = database.prepare(`
      INSERT INTO permissions (requester_mac, target_username, status, requested_at)
      VALUES (?, ?, 'pending', ?)
    `);
    stmt.run(requesterMac, targetUsername, new Date().toISOString());
  },

  checkPermission(requesterMac, targetUsername) {
    const stmt = database.prepare(`
      SELECT * FROM permissions
      WHERE requester_mac = ? AND target_username = ? AND status = 'approved'
    `);
    return stmt.get(requesterMac, targetUsername) || null;
  },

  listPendingPermissions() {
    const stmt = database.prepare(`
      SELECT p.*, u.name AS requester_name, u.role AS requester_role, u.sector AS requester_sector
      FROM permissions p
      JOIN users u ON p.requester_mac = u.mac
      WHERE p.status = 'pending'
      ORDER BY p.requested_at DESC
    `);
    return stmt.all();
  },

  listAllPermissions() {
    const stmt = database.prepare(`
      SELECT p.*, u.name AS requester_name, u.role AS requester_role
      FROM permissions p
      JOIN users u ON p.requester_mac = u.mac
      ORDER BY p.requested_at DESC
    `);
    return stmt.all();
  },

  updatePermissionStatus(id, status) {
    const stmt = database.prepare("UPDATE permissions SET status = ? WHERE id = ?");
    stmt.run(status, id);
  },

  // --- TAREFAS (TASKS) ---
  createTask({ title, description, assignedToMac }) {
    const stmt = database.prepare(`
      INSERT INTO tasks (title, description, assigned_to_mac, status, created_at)
      VALUES (?, ?, ?, 'pending', ?)
    `);
    stmt.run(title, description, assignedToMac, new Date().toISOString());
  },

  listTasks() {
    const stmt = database.prepare(`
      SELECT t.*, u.name AS assigned_to_name, u.role AS assigned_to_role
      FROM tasks t
      JOIN users u ON t.assigned_to_mac = u.mac
      ORDER BY t.created_at DESC
    `);
    return stmt.all();
  },

  updateTaskStatus(id, status) {
    const stmt = database.prepare("UPDATE tasks SET status = ? WHERE id = ?");
    stmt.run(status, id);
  },

  // --- DOCUMENTOS ---
  createDocument({ path, title, description, tags, authorName, authorRole, sourceFile, uploadedByMac }) {
    const stmt = database.prepare(`
      INSERT INTO documents (path, title, description, tags, author_name, author_role, source_file, uploaded_by_mac, uploaded_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(path) DO UPDATE SET
        title = excluded.title,
        description = excluded.description,
        tags = excluded.tags,
        author_name = excluded.author_name,
        author_role = excluded.author_role,
        source_file = excluded.source_file,
        uploaded_by_mac = excluded.uploaded_by_mac,
        uploaded_at = excluded.uploaded_at
    `);
    stmt.run(
      path,
      title,
      description,
      JSON.stringify(tags),
      authorName,
      authorRole,
      sourceFile,
      uploadedByMac,
      new Date().toISOString()
    );
  },

  listDocuments() {
    const stmt = database.prepare("SELECT * FROM documents ORDER BY uploaded_at DESC");
    return stmt.all().map(doc => ({
      ...doc,
      tags: JSON.parse(doc.tags)
    }));
  }
};
