const STABLE_FILENAME = 'maximus-gemma-4-E2B-it-web.litertlm';
const METADATA_FILENAME = `${STABLE_FILENAME}.json`;

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
  metadataFilename: METADATA_FILENAME,
  legacyFilenames: LEGACY_FILENAMES,
  displayName: 'Gemma 4 E2B IT Web',
  url: 'https://huggingface.co/litert-community/gemma-4-E2B-it-litert-lm/resolve/main/gemma-4-E2B-it-web.litertlm',
  approximateBytes: 2_008_000_000,
  minimumBytes: 1_900_000_000,
});

async function rootDirectory() {
  if (!navigator.storage?.getDirectory) {
    throw new Error('Este navegador não oferece OPFS. Use Chromium/Chrome atualizado.');
  }

  return navigator.storage.getDirectory();
}

async function readMetadata(root) {
  try {
    const handle = await root.getFileHandle(METADATA_FILENAME);
    const file = await handle.getFile();
    return JSON.parse(await file.text());
  } catch (error) {
    if (error?.name === 'NotFoundError' || error instanceof SyntaxError) return null;
    throw error;
  }
}

async function writeMetadata(root, metadata) {
  const handle = await root.getFileHandle(METADATA_FILENAME, {create: true});
  const writable = await handle.createWritable({keepExistingData: false});

  try {
    await writable.write(`${JSON.stringify(metadata, null, 2)}\n`);
    await writable.close();
  } catch (error) {
    await writable.abort().catch(() => {});
    throw error;
  }
}

async function inspectCandidate(root, filename, metadata) {
  try {
    const handle = await root.getFileHandle(filename);
    const file = await handle.getFile();

    const expectedBytes =
      filename === STABLE_FILENAME &&
      metadata?.complete === true &&
      Number.isFinite(Number(metadata.expectedBytes))
        ? Number(metadata.expectedBytes)
        : null;

    const complete = expectedBytes
      ? file.size === expectedBytes
      : file.size >= MODEL.minimumBytes;

    return {
      filename,
      file,
      complete,
      expectedBytes,
      legacy: filename !== STABLE_FILENAME,
    };
  } catch (error) {
    if (error?.name === 'NotFoundError') return null;
    throw error;
  }
}

async function findStoredModel() {
  const root = await rootDirectory();
  const metadata = await readMetadata(root);

  for (const filename of CANDIDATE_FILENAMES) {
    const candidate = await inspectCandidate(root, filename, metadata);
    if (!candidate) continue;

    return {
      ...candidate,
      root,
      metadata,
    };
  }

  return null;
}

export async function getStoredModelInfo() {
  const stored = await findStoredModel();

  if (!stored) {
    return {
      exists: false,
      complete: false,
      filename: null,
      size: 0,
    };
  }

  return {
    exists: true,
    complete: stored.complete,
    filename: stored.filename,
    size: stored.file.size,
    expectedBytes: stored.expectedBytes,
    legacy: stored.legacy,
  };
}

export async function getModelFile() {
  const stored = await findStoredModel();

  if (!stored) {
    throw new Error('A inteligência local ainda não foi preparada neste dispositivo.');
  }

  if (!stored.complete) {
    throw new Error('O arquivo local do modelo está incompleto e precisa ser baixado novamente.');
  }

  return stored.file;
}

export async function hasModel() {
  const stored = await findStoredModel();
  return Boolean(stored?.complete);
}

export async function needsModelDownload() {
  const stored = await findStoredModel();
  return !stored || !stored.complete;
}

/*
 * Remoção somente por ação explícita do usuário.
 * Nunca chame esta função por erro de WebGPU, <pad>, sessão ou inferência.
 */
export async function deleteModel() {
  const root = await rootDirectory();

  await Promise.all([
    ...CANDIDATE_FILENAMES,
    METADATA_FILENAME,
    `${STABLE_FILENAME}.download`,
  ].map(filename =>
    root.removeEntry(filename).catch(error => {
      if (error?.name !== 'NotFoundError') throw error;
    }),
  ));
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

  const existing = await findStoredModel();

  if (existing?.complete && !force) {
    onProgress({
      received: existing.file.size,
      total: existing.file.size,
      ratio: 1,
      reused: true,
      filename: existing.filename,
    });

    return existing.file;
  }

  const response = await fetch(MODEL.url, {
    signal,
    cache: 'no-store',
    redirect: 'follow',
  });

  if (!response.ok || !response.body) {
    throw new Error(`Falha no download do modelo: HTTP ${response.status}.`);
  }

  const expectedBytes =
    Number(response.headers.get('content-length')) || MODEL.approximateBytes;

  await ensureQuota(expectedBytes);

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
        total: expectedBytes,
        ratio: Math.min(1, received / expectedBytes),
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

  if (
    downloaded.size < MODEL.minimumBytes ||
    (expectedBytes > 0 && downloaded.size !== expectedBytes)
  ) {
    await root.removeEntry(temporaryFilename).catch(() => {});
    throw new Error(
      `O download ficou incompleto: ${formatBytes(downloaded.size)} de ${formatBytes(expectedBytes)}.`,
    );
  }

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

  const finalFile = await finalHandle.getFile();

  await writeMetadata(root, {
    version: 1,
    modelId: MODEL.id,
    filename: STABLE_FILENAME,
    expectedBytes: finalFile.size,
    complete: true,
    sourceUrl: MODEL.url,
    completedAt: new Date().toISOString(),
  });

  return finalFile;
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
