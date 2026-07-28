export const TRANSFORMERS_MODEL = Object.freeze({
  id: "onnx-community/gemma-3-1b-it-ONNX",
  dtype: "q4",
  device: "wasm",
  revision: "a58439f40017d3b99c7d378ff525e54e0ba08ebf",
  cacheKey: "maximus-engenharia-gemma3-q4-a58439f-v1-cache",
  markerKey: "maximus.engenharia.gemma3.q4.a58439f.v1.complete",
  approximateBytes: 900_000_000,
});

const ORT_WASM_BASE = "https://cdn.jsdelivr.net/npm/onnxruntime-web@1.26.0-dev.20260416-b7804b056c/dist/";

let client = null;
let activeMode = null;
let mainModulePromise = null;
let mainGeneratorPromise = null;
let mainGenerator = null;

function extractAssistantText(output) {
  const generated = output?.[0]?.generated_text;

  if (Array.isArray(generated)) {
    for (let index = generated.length - 1; index >= 0; index -= 1) {
      const message = generated[index];

      if (
        (message?.role === "assistant" || message?.role === "model") &&
        typeof message.content === "string"
      ) {
        return message.content.trim();
      }
    }
  }

  if (typeof generated === "string") return generated.trim();

  throw new Error("O modelo não produziu uma resposta reconhecível.");
}


function isMemoryError(error) {
  return /bad_alloc|OrtRun|ERROR_CODE:\s*6|out of memory|memory access/i
    .test(String(error?.message || error || ""));
}

function createMemoryError(error) {
  const cause = String(error?.message || error || "memória insuficiente");

  return new Error(
    "A memória disponível no navegador não foi suficiente para concluir " +
    "esta resposta. O modelo foi interrompido para liberar memória. " +
    "Recarregue a página e tente uma pergunta mais curta. " +
    `Detalhe técnico: ${cause}`,
  );
}

async function clearLegacyModelCaches() {
  if (!("caches" in globalThis)) return;

  const oldCacheKeys = [
    "maximus-engenharia-gemma3-cache",
    "maximus-engenharia-gemma3-int8-cache",
    "maximus-engenharia-gemma3-uint8-9909734-cache",
    "maximus-engenharia-gemma3-uint8-9909734-v2-cache",
  ];

  await Promise.all(
    oldCacheKeys.map(key => caches.delete(key).catch(() => false)),
  );

  for (const key of [
    "maximus.engenharia.gemma3.q4.complete",
    "maximus.engenharia.gemma3.int8.complete",
    "maximus.engenharia.gemma3.uint8.9909734.complete",
    "maximus.engenharia.gemma3.uint8.9909734.v2.complete",
  ]) {
    localStorage.removeItem(key);
  }
}

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

function writeCompleteMarker(mode) {
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
      mode,
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
      info.status === "runtime-import" ||
      info.status === "fallback-main" ||
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

async function loadMainModule(tracker) {
  if (!mainModulePromise) {
    tracker({
      status: "fallback-main",
      file: "Modo compatível",
    });

    mainModulePromise = import("@huggingface/transformers")
      .then(module => {
        const { env } = module;

        env.allowLocalModels = false;
        env.allowRemoteModels = true;
        env.useBrowserCache = true;
        env.useWasmCache = true;
        env.cacheKey = TRANSFORMERS_MODEL.cacheKey;
        env.backends.onnx.wasm.numThreads = 1;
        env.backends.onnx.wasm.proxy = false;
        env.backends.onnx.wasm.wasmPaths = ORT_WASM_BASE;

        return module;
      })
      .catch(error => {
        mainModulePromise = null;
        throw new Error(
          `Falha ao iniciar Transformers.js no modo compatível: ${
            error?.message || String(error)
          }`,
        );
      });
  }

  return mainModulePromise;
}

async function ensureMainGenerator(tracker) {
  if (!mainGeneratorPromise) {
    mainGeneratorPromise = loadMainModule(tracker)
      .then(({ pipeline }) => pipeline(
        "text-generation",
        TRANSFORMERS_MODEL.id,
        {
          dtype: TRANSFORMERS_MODEL.dtype,
          device: TRANSFORMERS_MODEL.device,
          revision: TRANSFORMERS_MODEL.revision,
          progress_callback: tracker,
        },
      ))
      .then(value => {
        mainGenerator = value;
        return value;
      })
      .catch(error => {
        mainGeneratorPromise = null;
        mainGenerator = null;
        throw error;
      });
  }

  return mainGeneratorPromise;
}

/*
 * O marcador é apenas um atalho de interface. A biblioteca continua
 * responsável por validar e reutilizar os arquivos do Cache API durante
 * pipeline(). Não fazemos consulta prévia ao registro de modelos porque essa
 * operação estava encerrando o worker em alguns navegadores.
 */
export async function hasCompleteMarker() {
  const matches = completeMarkerMatches();

  if (matches && !activeMode) {
    try {
      const value = JSON.parse(
        localStorage.getItem(TRANSFORMERS_MODEL.markerKey) || "null",
      );
      activeMode = value?.mode || "worker";
    } catch {
      activeMode = "worker";
    }
  }

  return matches;
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

  if (!("caches" in globalThis)) {
    throw new Error(
      "O Cache API não está disponível neste endereço.",
    );
  }

  await navigator.storage?.persist?.();
  await clearLegacyModelCaches();

  const tracker = createProgressTracker(onProgress);

  if ("Worker" in globalThis) {
    const activeClient = getClient({ recreateFailed: true });

    try {
      await activeClient.load(tracker);
      activeMode = "worker";
      writeCompleteMarker(activeMode);
      tracker({ status: "ready" });
      return true;
    } catch (error) {
      console.warn(
        "[Modelo] Worker indisponível; usando modo compatível:",
        error,
      );

      activeClient.failAll?.(error);

      if (client === activeClient) {
        client = null;
      }
    }
  }

  await ensureMainGenerator(tracker);

  activeMode = "main";
  writeCompleteMarker(activeMode);
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

  const maxTokens = Math.max(32, Math.min(128, maxNewTokens));

  if (activeMode === "worker") {
    const activeClient = getClient({ recreateFailed: true });

    try {
      return await activeClient.generate(messages, maxTokens);
    } catch (error) {
      activeClient.failAll?.(error);

      if (client === activeClient) {
        client = null;
      }

      if (isMemoryError(error)) {
        activeMode = null;
        throw createMemoryError(error);
      }

      console.warn(
        "[Modelo] Inferência no worker falhou; usando modo compatível:",
        error,
      );

      activeMode = "main";
    }
  }

  const tracker = () => {};
  const pipe = await ensureMainGenerator(tracker);

  let output;

  try {
    output = await pipe(messages, {
      max_new_tokens: maxTokens,
      do_sample: false,
      repetition_penalty: 1.08,
      return_full_text: true,
    });
  } catch (error) {
    if (isMemoryError(error)) {
      if (mainGenerator?.dispose) {
        await mainGenerator.dispose().catch(() => {});
      }

      mainGenerator = null;
      mainGeneratorPromise = null;
      mainModulePromise = null;
      activeMode = null;

      throw createMemoryError(error);
    }

    throw error;
  }

  writeCompleteMarker("main");

  return {
    text: extractAssistantText(output),
    mode: "main",
  };
}

export async function deleteTransformersModel() {
  localStorage.removeItem(TRANSFORMERS_MODEL.markerKey);

  if (client) {
    await client.dispose().catch(() => {});
    client = null;
  }

  if (mainGenerator?.dispose) {
    await mainGenerator.dispose().catch(() => {});
  }

  mainGenerator = null;
  mainGeneratorPromise = null;
  mainModulePromise = null;
  activeMode = null;
}
