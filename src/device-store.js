const DB_NAME = 'maximus-intelligence-local';
const DB_VERSION = 1;
const SETTINGS = 'settings';
const KEYS = 'keys';
const TOKEN_RECORD = 'github-token';
const TOKEN_KEY = 'github-token-key';
const encoder = new TextEncoder();
const decoder = new TextDecoder();

function bytesToBase64(bytes) {
  let binary = '';
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
}

function base64ToBytes(value) {
  const binary = atob(value);
  return Uint8Array.from(binary, character => character.charCodeAt(0));
}

function openDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(SETTINGS)) database.createObjectStore(SETTINGS);
      if (!database.objectStoreNames.contains(KEYS)) database.createObjectStore(KEYS);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('Falha ao abrir o armazenamento local.'));
  });
}

async function withStore(storeName, mode, operation) {
  const database = await openDatabase();
  try {
    return await new Promise((resolve, reject) => {
      const transaction = database.transaction(storeName, mode);
      const store = transaction.objectStore(storeName);
      const request = operation(store);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error('Falha no armazenamento local.'));
      transaction.onabort = () => reject(transaction.error ?? new Error('Transação local cancelada.'));
    });
  } finally {
    database.close();
  }
}

async function getOrCreateDeviceKey() {
  let key = await withStore(KEYS, 'readonly', store => store.get(TOKEN_KEY));
  if (key) return key;

  key = await crypto.subtle.generateKey(
    {name: 'AES-GCM', length: 256},
    false,
    ['encrypt', 'decrypt'],
  );
  await withStore(KEYS, 'readwrite', store => store.put(key, TOKEN_KEY));
  return key;
}

export async function saveGithubToken(token, remember) {
  const normalized = String(token ?? '').trim();
  if (!normalized) throw new Error('Informe o token do GitHub.');

  sessionStorage.setItem(TOKEN_RECORD, normalized);
  if (!remember) {
    await withStore(SETTINGS, 'readwrite', store => store.delete(TOKEN_RECORD));
    return;
  }

  const key = await getOrCreateDeviceKey();
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    {name: 'AES-GCM', iv},
    key,
    encoder.encode(normalized),
  );

  await withStore(SETTINGS, 'readwrite', store => store.put({
    iv: bytesToBase64(iv),
    ciphertext: bytesToBase64(new Uint8Array(ciphertext)),
    savedAt: new Date().toISOString(),
  }, TOKEN_RECORD));
}

export async function loadGithubToken() {
  const sessionToken = sessionStorage.getItem(TOKEN_RECORD);
  if (sessionToken) return sessionToken;

  const record = await withStore(SETTINGS, 'readonly', store => store.get(TOKEN_RECORD));
  if (!record) return '';

  try {
    const key = await withStore(KEYS, 'readonly', store => store.get(TOKEN_KEY));
    if (!key) return '';
    const plaintext = await crypto.subtle.decrypt(
      {name: 'AES-GCM', iv: base64ToBytes(record.iv)},
      key,
      base64ToBytes(record.ciphertext),
    );
    const token = decoder.decode(plaintext);
    sessionStorage.setItem(TOKEN_RECORD, token);
    return token;
  } catch {
    await clearGithubToken();
    return '';
  }
}

export async function clearGithubToken() {
  sessionStorage.removeItem(TOKEN_RECORD);
  await withStore(SETTINGS, 'readwrite', store => store.delete(TOKEN_RECORD));
}
