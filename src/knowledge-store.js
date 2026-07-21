const decoder = new TextDecoder();

const TEXT_EXTENSIONS = new Set([
  'txt', 'md', 'markdown', 'json', 'jsonl', 'csv', 'tsv', 'yaml', 'yml', 'xml', 'html', 'htm',
  'css', 'js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx', 'py', 'rb', 'lisp', 'cl', 'el', 'scm', 'sh', 'sql',
  'toml', 'ini', 'conf', 'log', 'java', 'kt', 'swift', 'go', 'rs', 'c', 'h', 'cpp', 'hpp', 'php',
]);

export function slugify(value, fallback = 'documento') {
  const slug = String(value ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
  return slug || fallback;
}

function fileExtension(name) {
  const match = String(name ?? '').toLowerCase().match(/\.([a-z0-9]+)$/);
  return match?.[1] || '';
}

function safeFilename(name) {
  const extension = fileExtension(name);
  const base = slugify(String(name ?? '').replace(/\.[^.]+$/, ''), 'arquivo');
  return extension ? `${base}.${extension}` : base;
}

export function isTextFile(metadata) {
  return String(metadata?.mimeType || '').startsWith('text/') ||
    ['application/json', 'application/xml', 'application/javascript', 'application/x-yaml'].includes(metadata?.mimeType) ||
    TEXT_EXTENSIONS.has(fileExtension(metadata?.name));
}

function userRoot(config, user) {
  return `${config.paths.users}/${user.id}`;
}

function manifestPath(config, user) {
  return `${userRoot(config, user)}/files/manifest.json`;
}

export async function listUserFiles(repository, config, user) {
  const manifest = await repository.getJson(manifestPath(config, user), {optional: true});
  const files = Array.isArray(manifest?.value?.files) ? manifest.value.files : [];
  return files.sort((left, right) => String(right.createdAt).localeCompare(String(left.createdAt)));
}

export async function uploadUserFile(repository, config, user, file) {
  if (!(file instanceof File)) throw new Error('Selecione um arquivo válido.');
  if (file.size > config.limits.maxUploadBytes) {
    throw new Error(`O arquivo excede o limite de ${Math.round(config.limits.maxUploadBytes / 1024 / 1024)} MB.`);
  }

  const id = crypto.randomUUID();
  const name = String(file.name || 'arquivo').slice(0, 180);
  const storedName = `${id}-${safeFilename(name)}`;
  const path = `${userRoot(config, user)}/files/content/${storedName}`;
  const bytes = new Uint8Array(await file.arrayBuffer());
  const metadata = {
    id,
    name,
    storedName,
    path,
    mimeType: String(file.type || 'application/octet-stream').slice(0, 120),
    size: file.size,
    textReadable: isTextFile({name, mimeType: file.type}),
    createdAt: new Date().toISOString(),
  };

  await repository.createFile(path, bytes, {message: `Upload de ${name} por ${user.username}`});
  await repository.updateJson(manifestPath(config, user), current => ({
    version: 1,
    files: [...(Array.isArray(current?.files) ? current.files : []), metadata],
  }), {message: `Registrar upload ${name}`});

  return metadata;
}

export async function readUserFile(repository, config, user, fileId, {maxChars} = {}) {
  const files = await listUserFiles(repository, config, user);
  const metadata = files.find(file => file.id === fileId);
  if (!metadata) throw new Error('Arquivo do usuário não encontrado.');
  if (!isTextFile(metadata)) {
    throw new Error('Este formato foi armazenado, mas ainda não possui extração de texto no navegador. Use TXT, Markdown, JSON, CSV ou código-fonte.');
  }

  const file = await repository.getFile(metadata.path);
  let content = decoder.decode(file.bytes);
  const limit = Math.max(1000, Number(maxChars) || config.limits.maxContextChars);
  const truncated = content.length > limit;
  if (truncated) content = content.slice(0, limit);
  return {metadata, content, truncated};
}

export async function searchUserFiles(repository, config, user, query) {
  const normalized = String(query ?? '').trim().toLowerCase();
  if (!normalized) throw new Error('Informe o texto da busca.');
  const files = (await listUserFiles(repository, config, user))
    .filter(isTextFile)
    .slice(0, config.limits.maxSearchFiles);
  const results = [];

  for (const metadata of files) {
    try {
      const {content} = await readUserFile(repository, config, user, metadata.id, {maxChars: 80_000});
      const index = content.toLowerCase().indexOf(normalized);
      if (index >= 0) {
        results.push({
          id: metadata.id,
          name: metadata.name,
          excerpt: content.slice(Math.max(0, index - 180), Math.min(content.length, index + normalized.length + 420)),
        });
      }
    } catch {
      // Um arquivo inválido não impede a busca nos demais.
    }
  }
  return results.slice(0, 12);
}

export async function listOkfDocuments(repository, config, user) {
  const [base, personal] = await Promise.all([
    repository.listMarkdownRecursive(config.paths.baseOkf, {maxFiles: 100, maxDepth: 5}),
    repository.listMarkdownRecursive(`${userRoot(config, user)}/okf`, {maxFiles: 100, maxDepth: 3}),
  ]);
  return [
    ...base.map(item => ({...item, scope: 'base'})),
    ...personal.map(item => ({...item, scope: 'user'})),
  ];
}

export async function readOkfDocument(repository, config, user, path, {maxChars} = {}) {
  const normalized = String(path ?? '').replace(/^\/+/, '');
  const allowedRoots = [config.paths.baseOkf, `${userRoot(config, user)}/okf`];
  if (!allowedRoots.some(root => normalized === root || normalized.startsWith(`${root}/`)) || !/\.md$/i.test(normalized)) {
    throw new Error('Documento OKF fora do escopo permitido.');
  }
  const file = await repository.getText(normalized);
  const limit = Math.max(1000, Number(maxChars) || config.limits.maxContextChars);
  return {
    path: normalized,
    content: file.content.slice(0, limit),
    truncated: file.content.length > limit,
  };
}

export async function searchOkf(repository, config, user, query) {
  const normalized = String(query ?? '').trim().toLowerCase();
  if (!normalized) throw new Error('Informe o texto da busca.');
  const documents = (await listOkfDocuments(repository, config, user)).slice(0, config.limits.maxSearchFiles);
  const results = [];

  for (const document of documents) {
    const file = await repository.getText(document.path);
    const index = file.content.toLowerCase().indexOf(normalized);
    if (index >= 0) {
      results.push({
        path: document.path,
        scope: document.scope,
        excerpt: file.content.slice(Math.max(0, index - 180), Math.min(file.content.length, index + normalized.length + 520)),
      });
    }
  }
  return results.slice(0, 12);
}

function yamlString(value) {
  return JSON.stringify(String(value ?? ''));
}

export function buildOkfMarkdown({title, type = 'reference', body, tags = [], sourcePath = '', user}) {
  const allowedTypes = new Set(['concept', 'howto', 'reference', 'decision', 'metric', 'index']);
  const normalizedType = allowedTypes.has(String(type).toLowerCase()) ? String(type).toLowerCase() : 'reference';
  const normalizedTitle = String(title || 'Documento sem título').replace(/[\r\n]+/g, ' ').trim().slice(0, 160);
  const normalizedBody = String(body || '').trim();
  if (!normalizedBody) throw new Error('O conteúdo do documento OKF está vazio.');
  const normalizedTags = [...new Set((Array.isArray(tags) ? tags : String(tags).split(','))
    .map(tag => slugify(tag, ''))
    .filter(Boolean))].slice(0, 12);

  return `---\ntype: ${normalizedType}\ntitle: ${yamlString(normalizedTitle)}\nuser_id: ${user.id}\ncreated_at: ${new Date().toISOString()}\n${sourcePath ? `source: ${yamlString(sourcePath)}\n` : ''}${normalizedTags.length ? `tags: [${normalizedTags.map(yamlString).join(', ')}]\n` : ''}---\n\n# ${normalizedTitle}\n\n${normalizedBody}\n`;
}

export async function createOkfDocument(repository, config, user, input) {
  const markdown = buildOkfMarkdown({...input, user});
  const filename = `${slugify(input.title)}-${crypto.randomUUID().slice(0, 8)}.md`;
  const path = `${userRoot(config, user)}/okf/${filename}`;
  await repository.createFile(path, markdown, {message: `Criar OKF ${input.title} para ${user.username}`});
  return {path, markdown};
}
