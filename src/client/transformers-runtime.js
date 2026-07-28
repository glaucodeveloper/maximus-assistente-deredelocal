export const TRANSFORMERS_MODEL = Object.freeze({
  id: "onnx-community/gemma-3-1b-it-ONNX",
  dtype: "uint8",
  device: "wasm",
  revision: "9909734e10b2001ee7de4a1ca33c9cfbe66ad30b",
  cacheKey: "maximus-engenharia-gemma3-uint8-9909734-v2-cache",
  markerKey: "maximus.engenharia.gemma3.uint8.9909734.v2.complete",
  approximateBytes: 1_050_000_000,
});

let client = null;

class WorkerClient {
  constructor() {
    this.failed = false;
    this.sequence = 0;
    this.pending = new Map();

    this.worker = new Worker(
      new URL("./transformers-worker.js", import.meta.url),
      { type: "module", name: "maximus-engenharia-gemma3" },
    );

    this.worker.addEventListener("message", event => {
      const { requestId, type, payload } = event.data ?? {};
      const request = this.pending.get(requestId);
      if (!request) return;

      if (type === "progress") {
        request.onProgress?.(payload);
        return;
      }

      this.pending.delete(requestId);

      if (type === "error") {
        const error = new Error(
          payload?.message ||
          "O worker da inteligência local informou uma falha.",
        );
        error.name = payload?.name || "Error";
        error.stack = payload?.stack || error.stack;
        request.reject(error);
        return;
      }

      request.resolve(payload);
    });

    this.worker.addEventListener("messageerror", event => {
      this.failAll(
        new Error(
          `O navegador não conseguiu decodificar uma mensagem do worker: ${
            event?.data ? String(event.data) : "mensagem inválida"
          }`,
        ),
      );
    });

    this.worker.addEventListener("error", event => {
      event.preventDefault?.();

      const location = [
        event.filename || "",
        event.lineno ? `linha ${event.lineno}` : "",
        event.colno ? `coluna ${event.colno}` : "",
      ].filter(Boolean).join(", ");

      const details = event.message || "erro sem mensagem";
      this.failAll(
        new Error(
          `O worker do Gemma foi encerrado: ${details}` +
          `${location ? ` (${location})` : ""}.`,
        ),
      );
    });
  }

  failAll(error) {
    this.failed = true;

    for (const request of this.pending.values()) {
      request.reject(error);
    }
    this.pending.clear();

    try {
      this.worker.terminate();
    } catch {
      // Worker já encerrado.
    }
  }

  request(type, payload = null, onProgress = null) {
    if (this.failed) {
      return Promise.reject(
        new Error("O worker anterior falhou e precisa ser recriado."),
      );
    }

    const requestId =
      `engenharia-gemma3-${Date.now()}-${++this.sequence}`;

    return new Promise((resolve, reject) => {
      this.pending.set(requestId, { resolve, reject, onProgress });
      this.worker.postMessage({ requestId, type, payload });
    });
  }

  load(onProgress) {
    return this.request("load", null, onProgress);
  }

  generate(messages, maxNewTokens) {
    return this.request("generate", { messages, maxNewTokens });
  }

  clearCache() {
    return this.request("clear-cache");
  }

  async dispose() {
    if (this.failed) return;

    try {
      await this.request("dispose");
    } finally {
      this.worker.terminate();
      this.failed = true;
    }
  }
}

function getClient({ recreateFailed = true } = {}) {
  if (client?.failed && recreateFailed) {
    client = null;
  }

  if (!client) {
    client = new WorkerClient();
  }

  return client;
}

function completeMarkerMatches() {
  try {
    const value = JSON.parse(
      localStorage.getItem(TRANSFORMERS_MODEL.markerKey) || "null",
    );

    return (
      value?.complete === true &&
      value?.modelId === TRANSFORMERS_MODEL.id &&
      value?.dtype === TRANSFORMERS_MODEL.dtype &&
      value?.revision === TRANSFORMERS_MODEL.revision
    );
  } catch {
    return false;
  }
}

function writeCompleteMarker() {
  for (const key of [
    "maximus.engenharia.gemma3.q4.complete",
    "maximus.engenharia.gemma3.int8.complete",
    "maximus.engenharia.gemma3.uint8.9909734.complete",
  ]) {
    localStorage.removeItem(key);
  }

  localStorage.setItem(
    TRANSFORMERS_MODEL.markerKey,
    JSON.stringify({
      complete: true,
      modelId: TRANSFORMERS_MODEL.id,
      dtype: TRANSFORMERS_MODEL.dtype,
      revision: TRANSFORMERS_MODEL.revision,
      completedAt: new Date().toISOString(),
    }),
  );
}

function createProgressTracker(onProgress) {
  const files = new Map();
  let lastRatio = 0;

  return info => {
    if (!info) return;

    let received = 0;
    let total = TRANSFORMERS_MODEL.approximateBytes;
    let ratio = lastRatio;

    if (info.status === "progress_total") {
      received = Number(info.loaded) || 0;
      total = Number(info.total) || TRANSFORMERS_MODEL.approximateBytes;
      const percent = Number(info.progress);
      ratio = Number.isFinite(percent)
        ? percent / 100
        : received / total;
    } else if (info.status === "progress" || info.status === "done") {
      const file = String(info.file || info.name || "arquivo");
      const known = files.get(file) || { loaded: 0, total: 0 };
      const fileTotal = Number(info.total) || known.total || 0;
      const fileLoaded = info.status === "done"
        ? fileTotal
        : Number(info.loaded) || known.loaded || 0;

      files.set(file, {
        loaded: fileLoaded,
        total: fileTotal,
      });

      received = [...files.values()]
        .reduce((sum, item) => sum + item.loaded, 0);

      const knownTotal = [...files.values()]
        .reduce((sum, item) => sum + item.total, 0);

      total = Math.max(
        TRANSFORMERS_MODEL.approximateBytes,
        knownTotal,
      );
      ratio = total > 0 ? received / total : lastRatio;
    } else if (info.status === "ready") {
      received = TRANSFORMERS_MODEL.approximateBytes;
      total = TRANSFORMERS_MODEL.approximateBytes;
      ratio = 1;
    } else if (
      info.status === "worker-ready" ||
      info.status === "connection" ||
      info.status === "connected" ||
      info.status === "initiate" ||
      info.status === "download"
    ) {
      ratio = lastRatio;
    } else {
      return;
    }

    ratio = Math.max(
      lastRatio,
      Math.min(1, Math.max(0, ratio || 0)),
    );
    lastRatio = ratio;

    onProgress({
      received,
      total,
      ratio,
      percent: Math.round(ratio * 100),
      status: info.status || "progress",
      file: String(info.file || info.name || ""),
    });
  };
}

/*
 * O marcador é apenas um atalho de interface. A biblioteca continua
 * responsável por validar e reutilizar os arquivos do Cache API durante
 * pipeline(). Não fazemos consulta prévia ao registro de modelos porque essa
 * operação estava encerrando o worker em alguns navegadores.
 */
export async function hasCompleteMarker() {
  return completeMarkerMatches();
}

export async function prepareTransformersModel({
  onProgress = () => {},
} = {}) {
  if (!globalThis.isSecureContext) {
    throw new Error(
      "A inteligência local exige HTTPS ou localhost. " +
      "Esta página não está em um contexto seguro.",
    );
  }

  if (!("Worker" in globalThis)) {
    throw new Error("Este navegador não oferece Web Worker.");
  }

  if (!("caches" in globalThis)) {
    throw new Error(
      "O Cache API não está disponível neste endereço.",
    );
  }

  await navigator.storage?.persist?.();

  const tracker = createProgressTracker(onProgress);
  tracker({
    status: "worker-ready",
    file: "Inicializando worker",
  });

  const activeClient = getClient({ recreateFailed: true });

  try {
    await activeClient.load(tracker);
  } catch (error) {
    if (client === activeClient) {
      client = null;
    }
    throw error;
  }

  writeCompleteMarker();
  tracker({ status: "ready" });
  return true;
}

export async function generateTransformersText(
  messages,
  { maxNewTokens = 256 } = {},
) {
  if (!(await hasCompleteMarker())) {
    await prepareTransformersModel();
  }

  const activeClient = getClient({ recreateFailed: true });

  try {
    return await activeClient.generate(
      messages,
      Math.max(64, Math.min(384, maxNewTokens)),
    );
  } catch (error) {
    if (client === activeClient) {
      client = null;
    }
    throw error;
  }
}

export async function deleteTransformersModel() {
  const activeClient = getClient({ recreateFailed: true });

  try {
    await activeClient.clearCache();
  } finally {
    localStorage.removeItem(TRANSFORMERS_MODEL.markerKey);
    await activeClient.dispose().catch(() => {});
    if (client === activeClient) {
      client = null;
    }
  }
}
