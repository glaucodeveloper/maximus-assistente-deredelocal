#!/usr/bin/env node
import { db } from "../services/db.js";

const rows = db.listDevices().map(device => ({
  deviceId: device.id,
  status: device.status,
  userId: device.user_mac,
  user: device.user_name,
  address: device.machine_address,
  lastIp: device.last_ip,
  lastSeen: device.last_seen_at,
}));

if (!rows.length) {
  console.log("Nenhum dispositivo pareado.");
} else {
  console.table(rows);
}
