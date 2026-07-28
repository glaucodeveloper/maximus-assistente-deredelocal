import {env, ModelRegistry, pipeline} from '@huggingface/transformers';

const MODEL_ID = 'onnx-community/gemma-3-1b-it-ONNX';
const MODEL_DTYPE = 'uint8';
const MODEL_DEVICE = 'wasm';
const MODEL_REVISION = '9909734e10b2001ee7de4a1ca33c9cfbe66ad30b';
const CACHE_KEY = 'maximus-engenharia-gemma3-uint8-9909734-cache';
const TASK = 'text-generation';
const MODEL_CONFIG_URL =
  `https://huggingface.co/${MODEL_ID}/resolve/${MODEL_REVISION}/config.json`;

const MODEL_OPTIONS = Object.freeze({
  dtype: MODEL_DTYPE,
  device: MODEL_DEVICE,
  revision: MODEL_REVISION,
});

env.allowLocalModels = false;
env.allowRemoteModels = true;
env.useBrowserCache = true;
env.useWasmCache = true;
env.cacheKey = CACHE_KEY;
env.backends.onnx.wasm.numThreads = self.crossOriginIsolated
  ? Math.max(1, Math.min(4, self.navigator?.hardwareConcurrency || 1))
  : 1;

let generatorPromise = null;
let generator = null;
let legacyCachesCleared = false;

function post(requestId, type, payload = null) {
  self.postMessage({requestId, type, payload});
}

function extractAssistantText(output) {
  const generated = output?.[0]?.generated_text;

  if (Array.isArray(generated)) {
    for (let index = generated.length - 1; index >= 0; index -= 1) {
      const message = generated[index];
      if ((message?.role === 'assistant' || message?.role === 'model') && typeof message.content === 'string') {
        return message.content.trim();
      }
    }
  }

  if (typeof generated === 'string') return generated.trim();
  throw new Error('A análise não produziu uma resposta reconhecível.');
}


async function verifyRemoteModel(requestId) {
  post(requestId, 'progress', {
    status: 'connection',
    file: 'Hugging Face',
  });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20000);

  try {
    const response = await fetch(MODEL_CONFIG_URL, {
      method: 'GET',
      cache: 'no-store',
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new Error(
        `Hugging Face respondeu HTTP ${response.status} ao consultar o modelo.`
      );
    }

    await response.arrayBuffer();

    post(requestId, 'progress', {
      status: 'connected',
      file: 'config.json',
    });
  } catch (error) {
    if (error?.name === 'AbortError') {
      throw new Error(
        'A conexão com o Hugging Face excedeu 20 segundos. Verifique internet, DNS ou firewall.'
      );
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function ensureGenerator(requestId) {
  if (!legacyCachesCleared && 'caches' in self) {
    await Promise.all([
      'maximus-engenharia-gemma3-cache',
      'maximus-engenharia-gemma3-int8-cache',
    ].map(key => caches.delete(key).catch(() => false)));
    legacyCachesCleared = true;
  }

  if (!generatorPromise) {
    await verifyRemoteModel(requestId);

    generatorPromise = pipeline(
      TASK,
      MODEL_ID,
      {
        ...MODEL_OPTIONS,
        progress_callback: progress => post(requestId, 'progress', progress),
      },
    ).then(value => {
      generator = value;
      return value;
    }).catch(error => {
      generatorPromise = null;
      generator = null;
      throw error;
    });
  }

  return generatorPromise;
}

self.addEventListener('message', async event => {
  const {requestId, type, payload} = event.data ?? {};

  try {
    if (type === 'cache-status') {
      const cached = await ModelRegistry.is_pipeline_cached(TASK, MODEL_ID, MODEL_OPTIONS);
      post(requestId, 'result', {cached});
      return;
    }

    if (type === 'clear-cache') {
      if (generator?.dispose) await generator.dispose();
      generator = null;
      generatorPromise = null;
      const result = await ModelRegistry.clear_pipeline_cache(TASK, MODEL_ID, MODEL_OPTIONS);
      post(requestId, 'result', result);
      return;
    }

    if (type === 'load') {
      await ensureGenerator(requestId);
      post(requestId, 'result', {ready: true});
      return;
    }

    if (type === 'generate') {
      const pipe = await ensureGenerator(requestId);
      const output = await pipe(payload.messages, {
        max_new_tokens: payload.maxNewTokens,
        do_sample: false,
        repetition_penalty: 1.08,
        return_full_text: true,
      });

      post(requestId, 'result', {text: extractAssistantText(output)});
      return;
    }

    if (type === 'dispose') {
      if (generator?.dispose) await generator.dispose();
      generator = null;
      generatorPromise = null;
      post(requestId, 'result', {disposed: true});
      return;
    }

    throw new Error(`Operação desconhecida do worker: ${type}`);
  } catch (error) {
    post(requestId, 'error', {
      name: error?.name || 'Error',
      message: error?.message || String(error),
      stack: error?.stack || '',
    });
  }
});
