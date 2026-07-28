export const TRANSFORMERS_MODEL = Object.freeze({
  id: 'onnx-community/gemma-3-1b-it-ONNX',
  dtype: 'uint8',
  device: 'wasm',
  revision: '9909734e10b2001ee7de4a1ca33c9cfbe66ad30b',
  cacheKey: 'maximus-engenharia-gemma3-uint8-9909734-cache',
  markerKey: 'maximus.engenharia.gemma3.uint8.9909734.complete',
  approximateBytes: 1_050_000_000,
});

let client = null;

class WorkerClient {
  constructor() {
    this.worker = new Worker(new URL('./transformers-worker.js', import.meta.url), {
      type: 'module',
    });
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
        const error = new Error(payload?.message || 'Não foi possível iniciar a análise.');
        error.name = payload?.name || 'Error';
        error.stack = payload?.stack || error.stack;
        request.reject(error);
        return;
      }

      request.resolve(payload);
    });

    this.worker.addEventListener('error', event => {
      const error = new Error(event.message || 'A análise foi interrompida.');
      for (const request of this.pending.values()) request.reject(error);
      this.pending.clear();
    });
  }

  request(type, payload = null, onProgress = null) {
    const requestId = `gemma3-${Date.now()}-${++this.sequence}`;

    return new Promise((resolve, reject) => {
      this.pending.set(requestId, {resolve, reject, onProgress});
      this.worker.postMessage({requestId, type, payload});
    });
  }

  load(onProgress) {
    return this.request('load', null, onProgress);
  }

  isCached() {
    return this.request('cache-status').then(result => Boolean(result?.cached));
  }

  clearCache() {
    return this.request('clear-cache');
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

function completeMarkerMatches() {
  try {
    const value = JSON.parse(localStorage.getItem(TRANSFORMERS_MODEL.markerKey) || 'null');
    return value?.complete === true &&
      value?.modelId === TRANSFORMERS_MODEL.id &&
      value?.dtype === TRANSFORMERS_MODEL.dtype &&
      value?.revision === TRANSFORMERS_MODEL.revision;
  } catch {
    return false;
  }
}

function writeCompleteMarker() {
  localStorage.removeItem('maximus.engenharia.gemma3.q4.complete');
  localStorage.removeItem('maximus.engenharia.gemma3.int8.complete');
  localStorage.setItem(TRANSFORMERS_MODEL.markerKey, JSON.stringify({
    complete: true,
    modelId: TRANSFORMERS_MODEL.id,
    dtype: TRANSFORMERS_MODEL.dtype,
    revision: TRANSFORMERS_MODEL.revision,
    completedAt: new Date().toISOString(),
  }));
}

function createProgressTracker(onProgress) {
  const files = new Map();
  let lastRatio = 0;

  return info => {
    if (!info) return;

    let received = 0;
    let total = TRANSFORMERS_MODEL.approximateBytes;
    let ratio = lastRatio;

    if (info.status === 'progress_total') {
      received = Number(info.loaded) || 0;
      total = Number(info.total) || TRANSFORMERS_MODEL.approximateBytes;
      const percent = Number(info.progress);
      ratio = Number.isFinite(percent) ? percent / 100 : received / total;
    } else if (info.status === 'progress' || info.status === 'done') {
      const file = String(info.file || info.name || 'arquivo');
      const known = files.get(file) || {loaded: 0, total: 0};
      const fileTotal = Number(info.total) || known.total || 0;
      const fileLoaded = info.status === 'done'
        ? fileTotal
        : Number(info.loaded) || known.loaded || 0;

      files.set(file, {loaded: fileLoaded, total: fileTotal});
      received = [...files.values()].reduce((sum, item) => sum + item.loaded, 0);
      const knownTotal = [...files.values()].reduce((sum, item) => sum + item.total, 0);
      total = Math.max(TRANSFORMERS_MODEL.approximateBytes, knownTotal);
      ratio = received / total;
    } else if (info.status === 'ready') {
      received = TRANSFORMERS_MODEL.approximateBytes;
      total = TRANSFORMERS_MODEL.approximateBytes;
      ratio = 1;
    } else {
      return;
    }

    ratio = Math.max(lastRatio, Math.min(1, Math.max(0, ratio || 0)));
    lastRatio = ratio;

    onProgress({
      received,
      total,
      ratio,
      percent: Math.round(ratio * 100),
    });
  };
}

export async function hasCompleteMarker() {
  const cached = await getClient().isCached().catch(() => false);
  if (!cached) {
    localStorage.removeItem(TRANSFORMERS_MODEL.markerKey);
    return false;
  }

  if (!completeMarkerMatches()) writeCompleteMarker();
  return true;
}

export async function prepareTransformersModel({onProgress = () => {}} = {}) {
  await navigator.storage?.persist?.();

  const tracker = createProgressTracker(onProgress);
  tracker({status: 'progress_total', loaded: 0, total: TRANSFORMERS_MODEL.approximateBytes, progress: 0});
  await getClient().load(tracker);

  const cached = await getClient().isCached();
  if (!cached) {
    localStorage.removeItem(TRANSFORMERS_MODEL.markerKey);
    throw new Error('O download da inteligência local não foi concluído.');
  }

  writeCompleteMarker();
  tracker({status: 'ready'});
  return true;
}

export async function generateTransformersText(messages, {maxNewTokens = 256} = {}) {
  if (!(await hasCompleteMarker())) await prepareTransformersModel();
  return getClient().generate(messages, Math.max(64, Math.min(256, maxNewTokens)));
}

export async function disposeTransformersRuntime() {
  if (!client) return;
  await client.dispose().catch(() => {});
  client = null;
}

export async function deleteTransformersModel() {
  const worker = getClient();
  await worker.clearCache().catch(() => {});
  localStorage.removeItem(TRANSFORMERS_MODEL.markerKey);
  await worker.dispose().catch(() => {});
  client = null;
}
