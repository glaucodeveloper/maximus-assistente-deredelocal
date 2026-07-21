const MODEL_MARKER_KEY = 'maximus.transformers.model.v1';

export const MODEL = Object.freeze({
  id: 'onnx-community/Qwen2.5-0.5B-Instruct',
  dtype: 'q8',
  displayName: 'Qwen 2.5 0.5B Instruct · CPU',
  approximateBytes: 535_000_000,
  cacheKey: 'maximus-transformers-cache',
  maxNewTokens: 192,
});

let client = null;

function modelMarker() {
  try {
    return JSON.parse(localStorage.getItem(MODEL_MARKER_KEY) || 'null');
  } catch {
    return null;
  }
}

function saveMarker() {
  localStorage.setItem(MODEL_MARKER_KEY, JSON.stringify({
    modelId: MODEL.id,
    dtype: MODEL.dtype,
    complete: true,
    completedAt: new Date().toISOString(),
  }));
}

class WorkerClient {
  constructor() {
    this.worker = new Worker(
      new URL('./transformers-worker.js', import.meta.url),
      {type: 'module'},
    );
    this.sequence = 0;
    this.pending = new Map();

    this.worker.addEventListener('message', event => {
      const {requestId, type, payload} = event.data ?? {};
      const request = this.pending.get(requestId);
      if (!request) return;

      if (type === 'progress') {
        request.onProgress?.(payload);
        return;
      }

      this.pending.delete(requestId);

      if (type === 'error') {
        const error = new Error(payload?.message || 'Falha no worker de inteligência local.');
        error.name = payload?.name || 'Error';
        error.stack = payload?.stack || error.stack;
        request.reject(error);
        return;
      }

      request.resolve(payload);
    });

    this.worker.addEventListener('error', event => {
      const error = new Error(event.message || 'O worker de inteligência local foi interrompido.');
      for (const request of this.pending.values()) request.reject(error);
      this.pending.clear();
    });
  }

  request(type, payload = null, onProgress = null) {
    const requestId = `tf-${Date.now()}-${++this.sequence}`;

    return new Promise((resolve, reject) => {
      this.pending.set(requestId, {resolve, reject, onProgress});
      this.worker.postMessage({requestId, type, payload});
    });
  }

  load(onProgress) {
    return this.request('load', null, onProgress);
  }

  generate(messages, maxNewTokens) {
    return this.request('generate', {messages, maxNewTokens});
  }

  async dispose() {
    try {
      await this.request('dispose');
    } finally {
      this.worker.terminate();
    }
  }
}

function getClient() {
  if (!client) client = new WorkerClient();
  return client;
}

function normalizeProgress(info) {
  if (!info || info.status !== 'progress') return null;

  const received = Number(info.loaded) || 0;
  const total = Number(info.total) || MODEL.approximateBytes;
  const ratio = Number.isFinite(Number(info.progress))
    ? Number(info.progress) / 100
    : received / total;

  return {
    received,
    total,
    ratio: Math.max(0, Math.min(1, ratio || 0)),
    file: info.file || '',
  };
}

export async function ensureTransformersRuntime({onProgress = () => {}} = {}) {
  await getClient().load(info => {
    const progress = normalizeProgress(info);
    if (progress) onProgress(progress);
  });
  saveMarker();
}

export async function downloadModel({onProgress = () => {}, signal} = {}) {
  if (signal?.aborted) throw new DOMException('Download cancelado.', 'AbortError');

  const abort = () => {};

  signal?.addEventListener('abort', abort, {once: true});

  try {
    await ensureTransformersRuntime({onProgress});
    if (signal?.aborted) throw new DOMException('Download cancelado.', 'AbortError');
    return true;
  } finally {
    signal?.removeEventListener('abort', abort);
  }
}

export async function hasModel() {
  const marker = modelMarker();

  if (
    marker?.complete !== true ||
    marker?.modelId !== MODEL.id ||
    marker?.dtype !== MODEL.dtype
  ) {
    return false;
  }

  if (!('caches' in globalThis)) return true;

  try {
    const cache = await caches.open(MODEL.cacheKey);
    const entries = await cache.keys();
    return entries.length > 0;
  } catch {
    return true;
  }
}

export async function getModelFile() {
  if (!(await hasModel())) {
    throw new Error('O modelo de CPU ainda não foi preparado neste dispositivo.');
  }
  return null;
}

export async function deleteModel() {
  if (client) {
    await client.dispose().catch(() => {});
    client = null;
  }

  localStorage.removeItem(MODEL_MARKER_KEY);
  if ('caches' in globalThis) await caches.delete(MODEL.cacheKey);
}

export function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';

  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const exponent = Math.min(
    Math.floor(Math.log(bytes) / Math.log(1024)),
    units.length - 1,
  );
  const value = bytes / 1024 ** exponent;

  return `${value.toFixed(exponent >= 3 ? 2 : 1)} ${units[exponent]}`;
}

class TransformersConversation {
  constructor(engine, preface = null) {
    this.engine = engine;
    this.cancelled = false;
    this.messages = Array.isArray(preface?.messages)
      ? preface.messages.map(message => ({
          role: message.role,
          content: String(message.content ?? ''),
        }))
      : [];
  }

  async sendMessage(input) {
    this.cancelled = false;
    this.messages.push({role: 'user', content: String(input ?? '')});

    const result = await this.engine.client.generate(
      this.messages,
      this.engine.maxNewTokens,
    );

    if (this.cancelled) throw new DOMException('Geração cancelada.', 'AbortError');

    const text = String(result?.text ?? '').trim();
    if (!text) throw new Error('O modelo de CPU não produziu conteúdo.');

    this.messages.push({role: 'assistant', content: text});

    return {
      content: [{type: 'text', text}],
    };
  }

  async *sendMessageStreaming(input) {
    yield await this.sendMessage(input);
  }

  cancel() {
    this.cancelled = true;
  }

  async delete() {
    this.cancelled = true;
    this.messages = [];
  }
}

export class Engine {
  constructor(workerClient, maxNewTokens) {
    this.client = workerClient;
    this.maxNewTokens = maxNewTokens;
  }

  static async create(options = {}) {
    const maxNewTokens = Math.max(
      64,
      Math.min(
        MODEL.maxNewTokens,
        Number(options?.mainExecutorSettings?.maxNumTokens) || MODEL.maxNewTokens,
      ),
    );

    await ensureTransformersRuntime();
    return new Engine(getClient(), maxNewTokens);
  }

  async createConversation({preface} = {}) {
    return new TransformersConversation(this, preface);
  }

  async delete() {
    if (!client) return;
    await client.dispose().catch(() => {});
    client = null;
  }
}
