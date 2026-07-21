const API_VERSION = '2026-03-10';
const encoder = new TextEncoder();
const decoder = new TextDecoder();

function normalizeSegment(value, label) {
  const normalized = String(value ?? '').trim();
  if (!normalized || !/^[A-Za-z0-9_.-]+$/.test(normalized)) {
    throw new Error(`${label} inválido em app-config.json.`);
  }
  return normalized;
}

export function normalizePath(value, {allowEmpty = false} = {}) {
  const normalized = String(value ?? '').trim().replace(/^\/+|\/+$/g, '');
  if ((!normalized && !allowEmpty) || normalized.split('/').some(segment => segment === '..')) {
    throw new Error('Caminho inválido no repositório.');
  }
  return normalized;
}

function bytesToBase64(bytes) {
  let binary = '';
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
}

function base64ToBytes(value) {
  const binary = atob(String(value ?? '').replace(/\s/g, ''));
  return Uint8Array.from(binary, character => character.charCodeAt(0));
}

function encodePath(path) {
  return normalizePath(path).split('/').map(encodeURIComponent).join('/');
}

async function parseError(response) {
  const payload = await response.json().catch(() => null);
  const details = payload?.message ? `: ${payload.message}` : '';
  return new Error(`GitHub respondeu ${response.status}${details}`);
}

export async function loadAppConfig() {
  const response = await fetch('./app-config.json', {cache: 'no-store'});
  if (!response.ok) throw new Error('Não foi possível carregar app-config.json.');
  const config = await response.json();

  const owner = normalizeSegment(config?.repository?.owner, 'Proprietário');
  const repo = normalizeSegment(config?.repository?.repo, 'Repositório');
  if (owner.startsWith('SEU_')) {
    throw new Error('Edite public/app-config.json e informe o repositório de dados antes de publicar.');
  }

  return {
    repository: {
      owner,
      repo,
      branch: normalizeSegment(config?.repository?.branch || 'main', 'Branch'),
      requirePrivate: config?.repository?.requirePrivate !== false,
    },
    brand: {
      company: String(config?.brand?.company || 'Maximus Empreendimentos').slice(0, 100),
      product: String(config?.brand?.product || 'Maximus Engenharia Inteligente').slice(0, 100),
      shortName: String(config?.brand?.shortName || 'Maximus Intelligence').slice(0, 60),
      tagline: String(config?.brand?.tagline || 'Conhecimento técnico transformado em decisão.').slice(0, 180),
    },
    paths: {
      baseOkf: normalizePath(config?.paths?.baseOkf || 'okf'),
      users: normalizePath(config?.paths?.users || 'data/users'),
    },
    confirmation: {
      enabled: config?.confirmation?.enabled !== false,
      requestsPath: normalizePath(config?.confirmation?.requestsPath || 'data/verification-requests'),
      expiresHours: Math.min(168, Math.max(1, Number(config?.confirmation?.expiresHours) || 24)),
      webUrl: String(config?.confirmation?.webUrl || location.href).slice(0, 500),
    },
    limits: {
      maxUploadBytes: Math.min(20 * 1024 * 1024, Math.max(64 * 1024, Number(config?.limits?.maxUploadBytes) || 8 * 1024 * 1024)),
      maxToolSteps: Math.min(8, Math.max(1, Number(config?.limits?.maxToolSteps) || 4)),
      maxContextChars: Math.min(80_000, Math.max(4_000, Number(config?.limits?.maxContextChars) || 24_000)),
      maxSearchFiles: Math.min(100, Math.max(5, Number(config?.limits?.maxSearchFiles) || 40)),
    },
    assistant: {
      name: String(config?.assistant?.name || 'Maximus Intelligence').slice(0, 80),
      welcome: String(config?.assistant?.welcome || 'Como posso ajudar?').slice(0, 500),
      systemPrompt: String(config?.assistant?.systemPrompt || 'Responda em português brasileiro.').slice(0, 12_000),
    },
    model: {
      maxNumTokens: Math.min(8192, Math.max(1024, Number(config?.model?.maxNumTokens) || 4096)),
    },
  };
}

export class GitHubRepository {
  constructor({token, config}) {
    this.token = String(token ?? '').trim();
    this.config = config;
    this.owner = config.repository.owner;
    this.repo = config.repository.repo;
    this.branch = config.repository.branch;
  }

  headers(extra = {}) {
    return {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${this.token}`,
      'X-GitHub-Api-Version': API_VERSION,
      ...extra,
    };
  }

  api(path) {
    return `https://api.github.com${path}`;
  }

  async validate() {
    const [userResponse, repoResponse] = await Promise.all([
      fetch(this.api('/user'), {headers: this.headers()}),
      fetch(this.api(`/repos/${encodeURIComponent(this.owner)}/${encodeURIComponent(this.repo)}`), {headers: this.headers()}),
    ]);

    if (!userResponse.ok) throw await parseError(userResponse);
    if (!repoResponse.ok) throw await parseError(repoResponse);

    const [user, repository] = await Promise.all([userResponse.json(), repoResponse.json()]);
    if (this.config.repository.requirePrivate && !repository.private) {
      throw new Error('O repositório de dados precisa ser privado. Altere app-config.json apenas se aceitar a exposição dos cadastros e arquivos.');
    }

    return {
      user: {login: user.login, name: user.name || user.login, avatarUrl: user.avatar_url},
      repository: {fullName: repository.full_name, private: repository.private, defaultBranch: repository.default_branch},
    };
  }

  async getContent(path, {signal, optional = false} = {}) {
    const endpoint = new URL(this.api(`/repos/${encodeURIComponent(this.owner)}/${encodeURIComponent(this.repo)}/contents/${encodePath(path)}`));
    endpoint.searchParams.set('ref', this.branch);
    const response = await fetch(endpoint, {signal, headers: this.headers()});

    if (optional && response.status === 404) return null;
    if (!response.ok) throw await parseError(response);
    return response.json();
  }

  async getBlob(sha, {signal} = {}) {
    const response = await fetch(
      this.api(`/repos/${encodeURIComponent(this.owner)}/${encodeURIComponent(this.repo)}/git/blobs/${encodeURIComponent(sha)}`),
      {signal, headers: this.headers()},
    );
    if (!response.ok) throw await parseError(response);
    const payload = await response.json();
    if (payload.encoding !== 'base64' || typeof payload.content !== 'string') {
      throw new Error('O GitHub não retornou o conteúdo do arquivo em base64.');
    }
    return base64ToBytes(payload.content);
  }

  async getFile(path, options = {}) {
    const payload = await this.getContent(path, options);
    if (!payload) return null;
    if (Array.isArray(payload) || payload.type !== 'file') {
      throw new Error(`${path} não aponta para um arquivo.`);
    }
    const bytes = typeof payload.content === 'string' && payload.content.trim()
      ? base64ToBytes(payload.content)
      : await this.getBlob(payload.sha, options);
    return {
      path: payload.path,
      name: payload.name,
      sha: payload.sha,
      size: payload.size,
      htmlUrl: payload.html_url,
      bytes,
      text() { return decoder.decode(this.bytes); },
    };
  }

  async getText(path, options = {}) {
    const file = await this.getFile(path, options);
    return file ? {...file, content: file.text()} : null;
  }

  async getJson(path, options = {}) {
    const file = await this.getText(path, options);
    if (!file) return null;
    try {
      return {...file, value: JSON.parse(file.content)};
    } catch (error) {
      throw new Error(`${path} não contém JSON válido.`, {cause: error});
    }
  }

  async list(path, {signal, optional = false} = {}) {
    const payload = await this.getContent(path, {signal, optional});
    if (!payload) return [];
    if (!Array.isArray(payload)) throw new Error(`${path} não aponta para um diretório.`);
    return payload.map(item => ({
      type: item.type,
      name: item.name,
      path: item.path,
      sha: item.sha,
      size: item.size,
      htmlUrl: item.html_url,
    }));
  }

  async putFile(path, content, {message, sha, signal} = {}) {
    const bytes = typeof content === 'string' ? encoder.encode(content) : new Uint8Array(content);
    const body = {
      message: String(message || `Atualizar ${path}`).slice(0, 200),
      content: bytesToBase64(bytes),
      branch: this.branch,
    };
    if (sha) body.sha = sha;

    const response = await fetch(
      this.api(`/repos/${encodeURIComponent(this.owner)}/${encodeURIComponent(this.repo)}/contents/${encodePath(path)}`),
      {
        method: 'PUT',
        signal,
        headers: this.headers({'Content-Type': 'application/json'}),
        body: JSON.stringify(body),
      },
    );
    if (!response.ok) throw await parseError(response);
    return response.json();
  }

  async createFile(path, content, options = {}) {
    const existing = await this.getFile(path, {optional: true});
    if (existing) throw new Error('Esse registro já existe.');
    return this.putFile(path, content, options);
  }

  async updateJson(path, mutator, {message, retries = 3} = {}) {
    let lastError;
    for (let attempt = 0; attempt < retries; attempt += 1) {
      try {
        const current = await this.getJson(path, {optional: true});
        const nextValue = await mutator(current?.value ?? null);
        return await this.putFile(path, `${JSON.stringify(nextValue, null, 2)}\n`, {
          message,
          sha: current?.sha,
        });
      } catch (error) {
        lastError = error;
        if (!String(error.message).includes('409') && !String(error.message).includes('sha')) throw error;
      }
    }
    throw lastError;
  }

  async listMarkdownRecursive(rootPath, {maxFiles = 100, maxDepth = 4} = {}) {
    const results = [];
    const queue = [{path: normalizePath(rootPath), depth: 0}];

    while (queue.length && results.length < maxFiles) {
      const current = queue.shift();
      const entries = await this.list(current.path, {optional: current.depth === 0});
      for (const entry of entries) {
        if (entry.type === 'dir' && current.depth < maxDepth) {
          queue.push({path: entry.path, depth: current.depth + 1});
        } else if (entry.type === 'file' && /\.md$/i.test(entry.name)) {
          results.push(entry);
          if (results.length >= maxFiles) break;
        }
      }
    }
    return results;
  }
}
