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
    throw new Error('O identificador deve ter de 3 a 32 caracteres: letras minúsculas, números, ponto, hífen ou sublinhado.');
  }
  return username;
}

export function normalizeEmail(value) {
  const email = String(value ?? '').trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 180) {
    throw new Error('Informe um e-mail corporativo válido.');
  }
  return email;
}

async function sha256Hex(value) {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(value)));
  return [...digest].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

export async function userIdFromUsername(username) {
  return sha256Hex(`maximus-engineering-user:${normalizeUsername(username)}`);
}

function publicUserId(userId) {
  return `MAX-USR-${String(userId).slice(0, 12).toUpperCase()}`;
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

function randomToken() {
  return bytesToBase64(crypto.getRandomValues(new Uint8Array(32)))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replaceAll('=', '');
}

function accountPath(config, userId) {
  return `${config.paths.users}/${userId}/account.json`;
}

function verificationRequestPath(config, requestId) {
  const root = String(config?.confirmation?.requestsPath || 'data/verification-requests').replace(/^\/+|\/+$/g, '');
  return `${root}/${requestId}.json`;
}

function verificationUrl(config, userId, token) {
  const base = String(config?.confirmation?.webUrl || location.href).split('?')[0].split('#')[0];
  const url = new URL(base, location.href);
  url.searchParams.set('verify_user', userId);
  url.searchParams.set('verify_token', token);
  return url.toString();
}

export async function registerUser(repository, config, {username, displayName, email, password}) {
  const normalizedUsername = normalizeUsername(username);
  const normalizedDisplayName = String(displayName || normalizedUsername).trim().slice(0, 80);
  const normalizedEmail = normalizeEmail(email);
  const userId = await userIdFromUsername(normalizedUsername);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const hash = await passwordHash(password, salt);
  const createdAt = new Date().toISOString();
  const confirmationEnabled = config?.confirmation?.enabled !== false;
  const token = randomToken();
  const tokenHash = await sha256Hex(token);
  const expiresHours = Math.max(1, Number(config?.confirmation?.expiresHours) || 24);
  const expiresAt = new Date(Date.now() + expiresHours * 60 * 60 * 1000).toISOString();
  const requestId = crypto.randomUUID();
  const publicId = publicUserId(userId);

  const account = {
    version: 2,
    id: userId,
    publicId,
    username: normalizedUsername,
    displayName: normalizedDisplayName,
    email: normalizedEmail,
    status: confirmationEnabled ? 'pending-email' : 'active',
    emailVerifiedAt: confirmationEnabled ? null : createdAt,
    password: {
      algorithm: 'PBKDF2-SHA256',
      iterations: ITERATIONS,
      salt: bytesToBase64(salt),
      hash: bytesToBase64(hash),
    },
    verification: confirmationEnabled ? {
      algorithm: 'SHA-256',
      tokenHash,
      expiresAt,
      requestId,
    } : null,
    createdAt,
    updatedAt: createdAt,
  };

  await repository.createFile(
    accountPath(config, userId),
    `${JSON.stringify(account, null, 2)}\n`,
    {message: `Solicitar acesso Maximus para ${normalizedUsername}`},
  );

  await repository.putFile(
    `${config.paths.users}/${userId}/files/manifest.json`,
    `${JSON.stringify({version: 1, files: []}, null, 2)}\n`,
    {message: `Inicializar artefatos de ${normalizedUsername}`},
  );

  await repository.putFile(
    `${config.paths.users}/${userId}/okf/index.md`,
    `---\ntype: index\ntitle: Conhecimento de ${normalizedDisplayName}\nuser_id: ${userId}\npublic_id: ${publicId}\ncreated_at: ${createdAt}\n---\n\n# Conhecimento de ${normalizedDisplayName}\n\nRegistros técnicos estruturados para este profissional.\n`,
    {message: `Inicializar conhecimento de ${normalizedUsername}`},
  );

  if (confirmationEnabled) {
    const request = {
      version: 1,
      requestId,
      userId,
      publicId,
      username: normalizedUsername,
      displayName: normalizedDisplayName,
      email: normalizedEmail,
      verificationUrl: verificationUrl(config, userId, token),
      expiresAt,
      createdAt,
    };
    await repository.createFile(
      verificationRequestPath(config, requestId),
      `${JSON.stringify(request, null, 2)}\n`,
      {message: `Enviar confirmação de acesso para ${publicId}`},
    );
  }

  return {
    id: userId,
    publicId,
    username: normalizedUsername,
    displayName: normalizedDisplayName,
    email: normalizedEmail,
    pendingVerification: confirmationEnabled,
  };
}

export async function verifyEmail(repository, config, {userId, token}) {
  const normalizedUserId = String(userId || '').trim().toLowerCase();
  const normalizedToken = String(token || '').trim();
  if (!/^[a-f0-9]{64}$/.test(normalizedUserId) || normalizedToken.length < 20) {
    throw new Error('O link de confirmação não é válido.');
  }

  const file = await repository.getJson(accountPath(config, normalizedUserId), {optional: true});
  if (!file) throw new Error('O cadastro associado a esta confirmação não foi encontrado.');
  const account = file.value;
  if (account.status === 'active' && account.emailVerifiedAt) {
    return {
      id: normalizedUserId,
      publicId: account.publicId || publicUserId(normalizedUserId),
      username: account.username,
      displayName: account.displayName,
      email: account.email,
    };
  }

  const expiresAt = Date.parse(account?.verification?.expiresAt || '');
  if (!Number.isFinite(expiresAt) || expiresAt < Date.now()) {
    throw new Error('Esta confirmação expirou. Solicite um novo cadastro ou uma nova confirmação.');
  }

  const computedHash = await sha256Hex(normalizedToken);
  if (computedHash !== account?.verification?.tokenHash) {
    throw new Error('A chave de confirmação não corresponde a este cadastro.');
  }

  const verifiedAt = new Date().toISOString();
  const updated = {
    ...account,
    status: 'active',
    emailVerifiedAt: verifiedAt,
    verification: null,
    updatedAt: verifiedAt,
  };
  await repository.putFile(
    accountPath(config, normalizedUserId),
    `${JSON.stringify(updated, null, 2)}\n`,
    {message: `Confirmar acesso ${updated.publicId || publicUserId(normalizedUserId)}`, sha: file.sha},
  );

  return {
    id: normalizedUserId,
    publicId: updated.publicId || publicUserId(normalizedUserId),
    username: updated.username,
    displayName: updated.displayName,
    email: updated.email,
  };
}

export async function loginUser(repository, config, {username, password}) {
  const normalizedUsername = normalizeUsername(username);
  const userId = await userIdFromUsername(normalizedUsername);
  const file = await repository.getJson(accountPath(config, userId), {optional: true});
  if (!file) throw new Error('Identificador ou senha inválidos.');

  const account = file.value;
  const salt = base64ToBytes(account?.password?.salt || '');
  const expected = base64ToBytes(account?.password?.hash || '');
  const computed = await passwordHash(password, salt, Number(account?.password?.iterations) || ITERATIONS);
  if (!equalBytes(computed, expected)) throw new Error('Identificador ou senha inválidos.');
  if (account.status !== 'active' || !account.emailVerifiedAt) {
    throw new Error('Seu acesso ainda aguarda a confirmação do e-mail corporativo.');
  }

  return {
    id: userId,
    publicId: account.publicId || publicUserId(userId),
    username: normalizedUsername,
    displayName: String(account.displayName || normalizedUsername).slice(0, 80),
    email: String(account.email || '').slice(0, 180),
  };
}
