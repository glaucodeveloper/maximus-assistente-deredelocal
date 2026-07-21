const encoder = new TextEncoder();
const ITERATIONS = 310_000;

function bytesToBase64(bytes) {
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}

function base64ToBytes(value) {
  const binary = atob(value);
  return Uint8Array.from(binary, character => character.charCodeAt(0));
}

export function normalizeUsername(value) {
  const username = String(value ?? '').trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9._-]{2,31}$/.test(username)) {
    throw new Error('O usuário deve ter 3 a 32 caracteres: letras minúsculas, números, ponto, hífen ou sublinhado.');
  }
  return username;
}

async function sha256Hex(value) {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(value)));
  return [...digest].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

export async function userIdFromUsername(username) {
  return sha256Hex(`okf-chat-user:${normalizeUsername(username)}`);
}

async function passwordHash(password, salt, iterations = ITERATIONS) {
  const normalized = String(password ?? '');
  if (normalized.length < 10) throw new Error('A senha precisa ter pelo menos 10 caracteres.');

  const baseKey = await crypto.subtle.importKey(
    'raw',
    encoder.encode(normalized),
    'PBKDF2',
    false,
    ['deriveBits'],
  );
  const bits = await crypto.subtle.deriveBits({
    name: 'PBKDF2',
    hash: 'SHA-256',
    salt,
    iterations,
  }, baseKey, 256);
  return new Uint8Array(bits);
}

function equalBytes(left, right) {
  if (left.length !== right.length) return false;
  let result = 0;
  for (let index = 0; index < left.length; index += 1) result |= left[index] ^ right[index];
  return result === 0;
}

function accountPath(config, userId) {
  return `${config.paths.users}/${userId}/account.json`;
}

export async function registerUser(repository, config, {username, displayName, password}) {
  const normalizedUsername = normalizeUsername(username);
  const normalizedDisplayName = String(displayName || normalizedUsername).trim().slice(0, 80);
  const userId = await userIdFromUsername(normalizedUsername);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const hash = await passwordHash(password, salt);
  const createdAt = new Date().toISOString();

  const account = {
    version: 1,
    id: userId,
    username: normalizedUsername,
    displayName: normalizedDisplayName,
    password: {
      algorithm: 'PBKDF2-SHA256',
      iterations: ITERATIONS,
      salt: bytesToBase64(salt),
      hash: bytesToBase64(hash),
    },
    createdAt,
    updatedAt: createdAt,
  };

  await repository.createFile(
    accountPath(config, userId),
    `${JSON.stringify(account, null, 2)}\n`,
    {message: `Cadastrar usuário ${normalizedUsername}`},
  );

  await repository.putFile(
    `${config.paths.users}/${userId}/files/manifest.json`,
    `${JSON.stringify({version: 1, files: []}, null, 2)}\n`,
    {message: `Inicializar arquivos de ${normalizedUsername}`},
  );

  await repository.putFile(
    `${config.paths.users}/${userId}/okf/index.md`,
    `---\ntype: index\ntitle: Conhecimento de ${normalizedDisplayName}\nuser_id: ${userId}\ncreated_at: ${createdAt}\n---\n\n# Conhecimento de ${normalizedDisplayName}\n\nDocumentos OKF criados para este usuário.\n`,
    {message: `Inicializar OKF de ${normalizedUsername}`},
  );

  return {id: userId, username: normalizedUsername, displayName: normalizedDisplayName};
}

export async function loginUser(repository, config, {username, password}) {
  const normalizedUsername = normalizeUsername(username);
  const userId = await userIdFromUsername(normalizedUsername);
  const file = await repository.getJson(accountPath(config, userId), {optional: true});
  if (!file) throw new Error('Usuário ou senha inválidos.');

  const account = file.value;
  const salt = base64ToBytes(account?.password?.salt || '');
  const expected = base64ToBytes(account?.password?.hash || '');
  const computed = await passwordHash(password, salt, Number(account?.password?.iterations) || ITERATIONS);
  if (!equalBytes(computed, expected)) throw new Error('Usuário ou senha inválidos.');

  return {
    id: userId,
    username: normalizedUsername,
    displayName: String(account.displayName || normalizedUsername).slice(0, 80),
  };
}
