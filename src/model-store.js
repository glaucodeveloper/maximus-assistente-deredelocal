/*
 * O modelo fica no OPFS, que pertence à origem do site.
 * Em GitHub Pages, trocar somente o caminho/repositório não muda a origem
 * https://<usuario>.github.io e, portanto, não apaga o arquivo.
 *
 * Não altere STABLE_FILENAME em atualizações comuns. Modelos realmente
 * incompatíveis devem receber outro id, mantendo os nomes antigos na lista
 * LEGACY_FILENAMES para permitir migração/reutilização explícita.
 */
const STABLE_FILENAME = 'maximus-gemma-4-E2B-it-web.litertlm';

const LEGACY_FILENAMES = Object.freeze([
  'gemma-4-E2B-it-web-r4.litertlm',
  'gemma-4-E2B-it-web-r3.litertlm',
  'gemma-4-E2B-it-web-r2.litertlm',
  'gemma-4-E2B-it-web-r1.litertlm',
  'gemma-4-E2B-it-web.litertlm',
]);

const CANDIDATE_FILENAMES = Object.freeze([
  STABLE_FILENAME,
  ...LEGACY_FILENAMES,
]);

export const MODEL = Object.freeze({
  id: 'gemma-4-e2b-web',
  filename: STABLE_FILENAME,
  legacyFilenames: LEGACY_FILENAMES,
  displayName: 'Gemma 4 E2B IT Web',
  url: 'https://huggingface.co/litert-community/gemma-4-E2B-it-litert-lm/resolve/main/gemma-4-E2B-it-web.litertlm',
  approximateBytes: 2_008_000_000,
  minimumBytes: 1_900_000_000,
  storageVersion: 5,
});

async function rootDirectory() {
  if (!navigator.storage?.getDirectory) {
    throw new Error('Este navegador não oferece OPFS. Use Chromium/Chrome atualizado.');
  }

  return navigator.storage.getDirectory();
}

async function findStoredModel({removeIncomplete = false} = {}) {
  const root = await rootDirectory();

  for (const filename of CANDIDATE_FILENAMES) {
    try {
      const handle = await root.getFileHandle(filename);
      const file = await handle.getFile();

      if (file.size >= MODEL.minimumBytes) {
        return {
          file,
          filename,
          isLegacy: filename !== STABLE_FILENAME,
        };
      }

      if (removeIncomplete) {
        await root.removeEntry(filename).catch(() => {});
      }
    } catch (error) {
      if (error?.name !== 'NotFoundError') throw error;
    }
  }

  return null;
}

export async function getModelFile() {
  const stored = await findStoredModel({removeIncomplete: true});

  if (!stored) {
    throw new Error('A inteligência local ainda não foi preparada neste dispositivo.');
  }

  // Não copia nem renomeia arquivos legados de 2 GB. O runtime pode abrir
  // diretamente o File encontrado no OPFS.
  return stored.file;
}

export async function getStoredModelInfo() {
  const stored = await findStoredModel();
  if (!stored) return null;

  return {
    filename: stored.filename,
    size: stored.file.size,
    isLegacy: stored.isLegacy,
  };
}

export async function hasModel() {
  return Boolean(await findStoredModel({removeIncomplete: true}));
}

/*
 * Só deve ser chamado por uma ação explícita do usuário.
 * Atualização do PWA, falha de sessão ou saída inválida não devem apagar 2 GB.
 */
export async function deleteModel() {
  const root = await rootDirectory();

  await Promise.all(
    CANDIDATE_FILENAMES.map(filename =>
      root.removeEntry(filename).catch(error => {
        if (error?.name !== 'NotFoundError') throw error;
      }),
    ),
  );
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

export async function downloadModel({
  onProgress = () => {},
  signal,
  force = false,
} = {}) {
  await navigator.storage?.persist?.();

  if (!force) {
    const stored = await findStoredModel({removeIncomplete: true});

    if (stored) {
      onProgress({
        received: stored.file.size,
        total: stored.file.size,
        ratio: 1,
        reused: true,
        filename: stored.filename,
      });

      return stored.file;
    }
  }

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
  const temporaryFilename = `${STABLE_FILENAME}.download`;
  const temporaryHandle = await root.getFileHandle(temporaryFilename, {create: true});
  const writable = await temporaryHandle.createWritable({keepExistingData: false});
  const reader = response.body.getReader();
  let received = 0;

  try {
    while (true) {
      const {done, value} = await reader.read();
      if (done) break;

      if (signal?.aborted) {
        throw new DOMException('Download cancelado.', 'AbortError');
      }

      await writable.write(value);
      received += value.byteLength;
      onProgress({
        received,
        total,
        ratio: Math.min(1, received / total),
        reused: false,
      });
    }

    await writable.close();
  } catch (error) {
    await writable.abort().catch(() => {});
    await root.removeEntry(temporaryFilename).catch(() => {});
    throw error;
  }

  const downloaded = await temporaryHandle.getFile();

  if (downloaded.size < MODEL.minimumBytes) {
    await root.removeEntry(temporaryFilename).catch(() => {});
    throw new Error('O download terminou com um arquivo menor que o esperado.');
  }

  /*
   * Publica somente depois de validar o tamanho. A cópia local ocorre apenas
   * em um download novo; arquivos legados válidos são usados no lugar.
   */
  const finalHandle = await root.getFileHandle(STABLE_FILENAME, {create: true});
  const finalWritable = await finalHandle.createWritable({keepExistingData: false});

  try {
    await downloaded.stream().pipeTo(finalWritable);
  } catch (error) {
    await finalWritable.abort().catch(() => {});
    await root.removeEntry(STABLE_FILENAME).catch(() => {});
    throw error;
  } finally {
    await root.removeEntry(temporaryFilename).catch(() => {});
  }

  const file = await finalHandle.getFile();

  if (file.size < MODEL.minimumBytes) {
    await root.removeEntry(STABLE_FILENAME).catch(() => {});
    throw new Error('O arquivo local do modelo ficou incompleto.');
  }

  return file;
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
