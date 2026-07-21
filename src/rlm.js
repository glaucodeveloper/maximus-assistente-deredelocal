import {
  createOkfDocument,
  listOkfDocuments,
  listUserFiles,
  readOkfDocument,
  readUserFile,
  searchOkf,
  searchUserFiles,
} from './knowledge-store.js';

const TOOL_PROTOCOL = `
Você pode solicitar ferramentas emitindo EXATAMENTE um bloco, sem texto fora dele:
<tool_call>{"name":"nome_da_ferramenta","arguments":{}}</tool_call>

Ferramentas disponíveis:
- list_user_files(): lista os arquivos do usuário atual.
- read_user_file({"fileId":"..."}): lê um arquivo textual do usuário.
- search_user_files({"query":"..."}): busca texto nos arquivos do usuário.
- list_okf(): lista documentos OKF da base compartilhada e do usuário.
- read_okf({"path":"..."}): lê um documento OKF.
- search_okf({"query":"..."}): busca na base OKF.
- create_okf({"title":"...","type":"concept|howto|reference|decision|metric","body":"Markdown","tags":["..."]}): cria conhecimento OKF do usuário após aprovação.
- create_okf_from_file({"fileId":"...","title":"...","type":"reference","body":"Markdown baseado no arquivo","tags":["..."]}): cria OKF relacionado a um arquivo após aprovação.

Regras:
1. Use ferramentas de leitura antes de afirmar algo sobre a base ou arquivos.
2. Nunca invente conteúdo ausente.
3. Para criar OKF, produza conteúdo útil e autocontido, indique a origem e solicite a ferramenta de escrita.
4. A aplicação executa a ferramenta; você não executa código.
5. Depois de receber TOOL_RESULT, continue a tarefa. Quando tiver a resposta final, responda normalmente, sem bloco tool_call.
`;

const SPECIAL_TOKEN_PATTERN = /<(?:pad|bos|eos|start_of_turn|end_of_turn)>/i;
const TOKEN_PATTERN = /<[^>]+>|[\p{L}\p{N}_-]+|[^\s]/gu;

export class UnsafeModelOutputError extends Error {
  constructor(message = 'A inteligência local produziu uma saída inválida.') {
    super(message);
    this.name = 'UnsafeModelOutputError';
    this.code = 'UNSAFE_MODEL_OUTPUT';
  }
}

export function buildRlmSystemPrompt(config) {
  return `${config.assistant.systemPrompt}\n\nVocê trabalha com Open Knowledge Format (OKF): Markdown com frontmatter YAML e links Markdown, organizado em diretórios versionados no Git.\n${TOOL_PROTOCOL}`;
}

function truncate(value, limit) {
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  return text.length > limit ? `${text.slice(0, limit)}\n…[resultado truncado]` : text;
}

function parseToolCall(text) {
  const match = String(text ?? '').match(/<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/i);
  if (!match) return null;
  try {
    const parsed = JSON.parse(match[1]);
    if (!parsed || typeof parsed.name !== 'string' || typeof parsed.arguments !== 'object') {
      throw new Error('Estrutura de ferramenta inválida.');
    }
    return {name: parsed.name, arguments: parsed.arguments ?? {}};
  } catch (error) {
    return {parseError: error.message};
  }
}

function hasRepetitionLoop(value) {
  const tokens = String(value ?? '').toLowerCase().match(TOKEN_PATTERN) ?? [];
  if (tokens.length < 36) return false;
  const tail = tokens.slice(-36);
  const unique = new Set(tail);
  if (unique.size <= 2) return true;

  for (const width of [1, 2, 3, 4]) {
    const pattern = tail.slice(-width).join('\u0000');
    let repeats = 0;
    for (let offset = tail.length - width; offset >= 0; offset -= width) {
      if (tail.slice(offset, offset + width).join('\u0000') !== pattern) break;
      repeats += 1;
    }
    if (repeats >= 8) return true;
  }
  return false;
}

async function collectSafe(stream, {cancel = () => {}, maxChars = 64_000} = {}) {
  let text = '';
  for await (const chunk of stream) {
    for (const item of chunk.content ?? []) {
      if (item.type !== 'text') continue;
      text += item.text;

      if (SPECIAL_TOKEN_PATTERN.test(text)) {
        cancel();
        throw new UnsafeModelOutputError('A sessão local emitiu tokens internos e foi interrompida antes de exibir o conteúdo.');
      }
      if (text.length > maxChars) {
        cancel();
        throw new UnsafeModelOutputError('A resposta ultrapassou o limite seguro de geração e foi interrompida.');
      }
      if (hasRepetitionLoop(text)) {
        cancel();
        throw new UnsafeModelOutputError('A geração entrou em repetição e foi interrompida antes de chegar à interface.');
      }
    }
  }

  const normalized = text.trim();
  if (!normalized) throw new UnsafeModelOutputError('A inteligência local não produziu uma resposta válida.');
  return normalized;
}

export async function validateModelEngine(engine) {
  // Teste isolado: sem prompt de sistema, ferramentas ou histórico.
  // Isso evita confundir falha do runtime com falha do RLM.
  const conversation = await engine.createConversation();

  try {
    const response = await conversation.sendMessage(
      'Responda somente com a palavra OK.',
    );

    const text = (response?.content ?? [])
      .filter(item => item?.type === 'text')
      .map(item => item.text ?? '')
      .join('')
      .trim();

    if (SPECIAL_TOKEN_PATTERN.test(text) || hasRepetitionLoop(text)) {
      throw new UnsafeModelOutputError(
        'O runtime emitiu tokens internos durante o teste mínimo.',
      );
    }

    if (!/^OK[.!]?$/i.test(text)) {
      throw new UnsafeModelOutputError(
        `O modelo abriu, mas não produziu uma resposta válida no teste mínimo: ${text.slice(0, 120) || '[vazio]'}`,
      );
    }

    return true;
  } finally {
    conversation.cancel?.();
  }
}

function toolLabel(name) {
  return ({
    list_user_files: 'Mapeando artefatos autorizados',
    read_user_file: 'Analisando artefato técnico',
    search_user_files: 'Pesquisando na base técnica',
    list_okf: 'Listando a base OKF',
    read_okf: 'Consultando conhecimento estruturado',
    search_okf: 'Buscando na base OKF',
    create_okf: 'Preparando documento OKF',
    create_okf_from_file: 'Transformando artefato em conhecimento estruturado',
  })[name] || `Executando ${name}`;
}

async function executeTool({call, repository, config, user, requestApproval}) {
  const args = call.arguments ?? {};

  switch (call.name) {
    case 'list_user_files':
      return (await listUserFiles(repository, config, user)).map(file => ({
        id: file.id,
        name: file.name,
        mimeType: file.mimeType,
        size: file.size,
        textReadable: file.textReadable,
        createdAt: file.createdAt,
      }));

    case 'read_user_file': {
      const result = await readUserFile(repository, config, user, String(args.fileId || ''));
      return {
        id: result.metadata.id,
        name: result.metadata.name,
        path: result.metadata.path,
        content: result.content,
        truncated: result.truncated,
      };
    }

    case 'search_user_files':
      return searchUserFiles(repository, config, user, String(args.query || ''));

    case 'list_okf':
      return (await listOkfDocuments(repository, config, user)).map(document => ({
        path: document.path,
        scope: document.scope,
        name: document.name,
      }));

    case 'read_okf':
      return readOkfDocument(repository, config, user, String(args.path || ''));

    case 'search_okf':
      return searchOkf(repository, config, user, String(args.query || ''));

    case 'create_okf': {
      const input = {
        title: String(args.title || 'Documento OKF'),
        type: String(args.type || 'reference'),
        body: String(args.body || ''),
        tags: Array.isArray(args.tags) ? args.tags : [],
      };
      const approved = await requestApproval({
        kind: 'create_okf',
        title: input.title,
        description: 'A inteligência propõe incorporar este conhecimento ao espaço técnico do usuário.',
        preview: input.body.slice(0, 3000),
      });
      if (!approved) return {status: 'cancelled', message: 'A proposta foi descartada sem alterar a base Maximus.'};
      const created = await createOkfDocument(repository, config, user, input);
      return {status: 'created', path: created.path};
    }

    case 'create_okf_from_file': {
      const source = await readUserFile(repository, config, user, String(args.fileId || ''));
      const input = {
        title: String(args.title || `Conhecimento sobre ${source.metadata.name}`),
        type: String(args.type || 'reference'),
        body: String(args.body || ''),
        tags: Array.isArray(args.tags) ? args.tags : ['upload'],
        sourcePath: source.metadata.path,
      };
      if (!input.body.trim()) throw new Error('A ferramenta create_okf_from_file precisa receber o corpo Markdown produzido a partir do arquivo.');
      const approved = await requestApproval({
        kind: 'create_okf_from_file',
        title: input.title,
        description: `A inteligência propõe criar conhecimento estruturado com base em “${source.metadata.name}”.`,
        preview: input.body.slice(0, 3000),
      });
      if (!approved) return {status: 'cancelled', message: 'A proposta foi descartada sem alterar a base Maximus.'};
      const created = await createOkfDocument(repository, config, user, input);
      return {status: 'created', path: created.path, source: source.metadata.path};
    }

    default:
      throw new Error(`Ferramenta não permitida: ${call.name}`);
  }
}

export async function runRlm({
  conversation,
  repository,
  config,
  user,
  prompt,
  onStatus = () => {},
  requestApproval = async () => false,
}) {
  let nextInput = String(prompt ?? '').trim();
  if (!nextInput) return '';

  for (let step = 0; step <= config.limits.maxToolSteps; step += 1) {
    onStatus(step === 0 ? 'Analisando pergunta…' : `Raciocínio recursivo ${step}/${config.limits.maxToolSteps}…`);
    const output = await collectSafe(
      conversation.sendMessageStreaming(nextInput),
      {cancel: () => conversation.cancel?.(), maxChars: 64_000},
    );
    const call = parseToolCall(output);

    if (!call) return output;
    if (call.parseError) {
      nextInput = `Seu tool_call não era JSON válido: ${call.parseError}. Emita novamente apenas o bloco <tool_call>{...}</tool_call>.`;
      continue;
    }
    if (step === config.limits.maxToolSteps) {
      return 'Não consegui concluir dentro do limite de operações configurado. Reformule a pergunta ou aumente maxToolSteps em app-config.json.';
    }

    onStatus(`${toolLabel(call.name)}…`);
    let result;
    try {
      result = await executeTool({call, repository, config, user, requestApproval});
    } catch (error) {
      result = {error: error.message};
    }

    nextInput = `TOOL_RESULT ${call.name}:\n${truncate(result, config.limits.maxContextChars)}\n\nContinue a tarefa. Use outra ferramenta se necessário ou forneça a resposta final.`;
  }

  return 'A execução terminou sem resposta final.';
}
