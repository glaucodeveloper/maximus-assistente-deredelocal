export const MODEL = Object.freeze({
  id: 'gemma-4-e2b-web',
  filename: 'gemma-4-E2B-it-web.litertlm',
  displayName: 'Gemma 4 E2B IT Web',
  url: 'https://huggingface.co/litert-community/gemma-4-E2B-it-litert-lm/resolve/main/gemma-4-E2B-it-web.litertlm',
  approximateBytes: 2_008_000_000,
});

async function rootDirectory() {
  if (!navigator.storage?.getDirectory) {
    throw new Error('Este navegador não oferece OPFS. Use Chromium/Chrome atualizado.');
  }

  return navigator.storage.getDirectory();
}

export async function getModelFile() {
  const root = await rootDirectory();
  const handle = await root.getFileHandle(MODEL.filename);
  const file = await handle.getFile();

  if (file.size < 1_500_000_000) {
    throw new Error('O arquivo local do modelo está incompleto. Baixe novamente.');
  }

  return file;
}

export async function hasModel() {
  try {
    await getModelFile();
    return true;
  } catch {
    return false;
  }
}

export async function deleteModel() {
  const root = await rootDirectory();
  await root.removeEntry(MODEL.filename).catch(error => {
    if (error?.name !== 'NotFoundError') throw error;
  });
}

async function ensureQuota(requiredBytes) {
  const estimate = await navigator.storage?.estimate?.();

  if (!estimate?.quota) return;

  const available = estimate.quota - (estimate.usage ?? 0);
  const reserve = 256 * 1024 * 1024;

  if (available < requiredBytes + reserve) {
    throw new Error(
      `Espaço insuficiente. Disponível: ${formatBytes(available)}; necessário: aproximadamente ${formatBytes(requiredBytes + reserve)}.`,
    );
  }
}

export async function downloadModel({onProgress = () => {}, signal} = {}) {
  await navigator.storage?.persist?.();

  const response = await fetch(MODEL.url, {
    signal,
    cache: 'no-store',
    redirect: 'follow',
  });

  if (!response.ok || !response.body) {
    throw new Error(`Falha no download do modelo: HTTP ${response.status}.`);
  }

  const total = Number(response.headers.get('content-length')) || MODEL.approximateBytes;
  await ensureQuota(total);

  const root = await rootDirectory();
  const handle = await root.getFileHandle(MODEL.filename, {create: true});
  const writable = await handle.createWritable({keepExistingData: false});
  const reader = response.body.getReader();
  let received = 0;

  try {
    while (true) {
      const {done, value} = await reader.read();
      if (done) break;
      if (signal?.aborted) throw new DOMException('Download cancelado.', 'AbortError');

      await writable.write(value);
      received += value.byteLength;
      onProgress({received, total, ratio: Math.min(1, received / total)});
    }

    await writable.close();
  } catch (error) {
    await writable.abort().catch(() => {});
    await root.removeEntry(MODEL.filename).catch(() => {});
    throw error;
  }

  const file = await handle.getFile();
  if (file.size < 1_500_000_000) {
    await root.removeEntry(MODEL.filename).catch(() => {});
    throw new Error('O download terminou com um arquivo menor que o esperado.');
  }

  return file;
}

export function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const exponent = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / 1024 ** exponent;
  return `${value.toFixed(exponent >= 3 ? 2 : 1)} ${units[exponent]}`;
}
