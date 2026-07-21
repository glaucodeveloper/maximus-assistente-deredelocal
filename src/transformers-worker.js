import {env, pipeline} from '@huggingface/transformers';

const MODEL_ID = 'onnx-community/Qwen2.5-0.5B-Instruct';
const MODEL_DTYPE = 'q8';

env.allowLocalModels = false;
env.allowRemoteModels = true;
env.useBrowserCache = true;
env.useWasmCache = true;
env.cacheKey = 'maximus-transformers-cache';

let generatorPromise = null;
let generator = null;

function post(requestId, type, payload = null) {
  self.postMessage({requestId, type, payload});
}

function extractAnswer(output) {
  const generated = output?.[0]?.generated_text;

  if (Array.isArray(generated)) {
    for (let index = generated.length - 1; index >= 0; index -= 1) {
      const item = generated[index];
      if (item?.role === 'assistant' && typeof item.content === 'string') {
        return item.content.trim();
      }
    }
  }

  if (typeof generated === 'string') {
    return generated.trim();
  }

  throw new Error('O modelo não produziu uma resposta textual reconhecível.');
}

async function loadGenerator(requestId) {
  if (!generatorPromise) {
    generatorPromise = pipeline(
      'text-generation',
      MODEL_ID,
      {
        dtype: MODEL_DTYPE,
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
    if (type === 'load') {
      await loadGenerator(requestId);
      post(requestId, 'result', {ready: true});
      return;
    }

    if (type === 'generate') {
      const pipe = await loadGenerator(requestId);
      const output = await pipe(payload.messages, {
        max_new_tokens: payload.maxNewTokens,
        do_sample: false,
        repetition_penalty: 1.08,
        return_full_text: true,
      });

      post(requestId, 'result', {text: extractAnswer(output)});
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
