const DB_NAME = 'litert-gemma-pwa';
const DB_VERSION = 1;
const STORE = 'settings';
const CONNECTION_KEY = 'github-connection';
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
      if (!request.result.objectStoreNames.contains(STORE)) {
        request.result.createObjectStore(STORE);
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('Falha ao abrir IndexedDB.'));
  });
}

async function transaction(mode, operation) {
  const database = await openDatabase();

  try {
    return await new Promise((resolve, reject) => {
      const tx = database.transaction(STORE, mode);
      const store = tx.objectStore(STORE);
      const request = operation(store);

      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error('Falha no armazenamento local.'));
      tx.onabort = () => reject(tx.error ?? new Error('Transação local cancelada.'));
    });
  } finally {
    database.close();
  }
}

async function deriveKey(passphrase, salt) {
  const baseKey = await crypto.subtle.importKey(
    'raw',
    encoder.encode(passphrase),
    'PBKDF2',
    false,
    ['deriveKey'],
  );

  return crypto.subtle.deriveKey(
    {
      name: 'PBKDF2',
      hash: 'SHA-256',
      salt,
      iterations: 310_000,
    },
    baseKey,
    {name: 'AES-GCM', length: 256},
    false,
    ['encrypt', 'decrypt'],
  );
}

async function encryptSecret(secret, passphrase) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKey(passphrase, salt);
  const ciphertext = await crypto.subtle.encrypt(
    {name: 'AES-GCM', iv},
    key,
    encoder.encode(secret),
  );

  return {
    algorithm: 'AES-GCM/PBKDF2-SHA256',
    salt: bytesToBase64(salt),
    iv: bytesToBase64(iv),
    ciphertext: bytesToBase64(new Uint8Array(ciphertext)),
  };
}

async function decryptSecret(payload, passphrase) {
  try {
    const salt = base64ToBytes(payload.salt);
    const iv = base64ToBytes(payload.iv);
    const key = await deriveKey(passphrase, salt);
    const plaintext = await crypto.subtle.decrypt(
      {name: 'AES-GCM', iv},
      key,
      base64ToBytes(payload.ciphertext),
    );

    return decoder.decode(plaintext);
  } catch (error) {
    throw new Error('Senha local incorreta ou configuração corrompida.', {cause: error});
  }
}

export async function saveConnection(connection, token, passphrase) {
  if (!passphrase || passphrase.length < 8) {
    throw new Error('A senha local precisa ter pelo menos 8 caracteres.');
  }

  const encryptedToken = await encryptSecret(token, passphrase);
  const record = {
    owner: connection.owner,
    repo: connection.repo,
    branch: connection.branch,
    configPath: connection.configPath,
    encryptedToken,
    savedAt: new Date().toISOString(),
  };

  await transaction('readwrite', store => store.put(record, CONNECTION_KEY));
  return record;
}

export function loadConnection() {
  return transaction('readonly', store => store.get(CONNECTION_KEY));
}

export async function unlockConnection(passphrase) {
  const record = await loadConnection();

  if (!record) {
    throw new Error('A conexão com o repositório ainda não foi configurada.');
  }

  const token = await decryptSecret(record.encryptedToken, passphrase);
  return {...record, token};
}

export function removeConnection() {
  return transaction('readwrite', store => store.delete(CONNECTION_KEY));
}
