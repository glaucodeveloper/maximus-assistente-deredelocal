import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { basename, extname, resolve } from "node:path";
import pdfParse from "pdf-parse";
import { db } from "./db.js";
import { geminiService } from "./gemini.js";

mkdirSync("okf/knowledge", { recursive: true });
mkdirSync("okf/uploads_raw/.archive", { recursive: true });

function normalizeIp(value) {
  const normalized = String(value || "").trim().replace(/^::ffff:/, "");
  return normalized === "::1" ? "127.0.0.1" : normalized;
}

function validMac(value) {
  const mac = String(value || "").trim().toLowerCase();
  if (!/^([a-f0-9]{2}:){5}[a-f0-9]{2}$/.test(mac)) return null;
  if (mac === "00:00:00:00:00:00" || mac === "ff:ff:ff:ff:ff:ff") return null;
  return mac;
}

function localMachineAddress() {
  try {
    const machineId = readFileSync("/etc/machine-id", "utf8").trim();
    if (machineId) {
      return `local:${createHash("sha256").update(machineId).digest("hex").slice(0, 32)}`;
    }
  } catch {
    // Ambiente sem /etc/machine-id.
  }
  return null;
}

/**
 * Resolve o endereço físico observado pelo servidor.
 *
 * Esse vínculo funciona quando cliente e servidor estão no mesmo segmento L2.
 * Em VPN, NAT, proxy ou redes roteadas, o endereço pode não estar disponível.
 */
export function getMacFromIp(ip) {
  const normalizedIp = normalizeIp(ip);
  if (
    normalizedIp === "127.0.0.1" ||
    normalizedIp === "localhost" ||
    normalizedIp === ""
  ) {
    return localMachineAddress();
  }

  try {
    const arpData = readFileSync("/proc/net/arp", "utf8");
    for (const line of arpData.split("\n").slice(1)) {
      const parts = line.trim().split(/\s+/);
      if (parts[0] === normalizedIp) {
        const mac = validMac(parts[3]);
        if (mac) return mac;
      }
    }
  } catch {
    // Tenta ip neigh abaixo.
  }

  try {
    const output = execFileSync(
      "ip",
      ["neigh", "show", normalizedIp],
      { encoding: "utf8", timeout: 1500 },
    );
    const match = output.match(/\blladdr\s+(([a-f0-9]{2}:){5}[a-f0-9]{2})\b/i);
    const mac = validMac(match?.[1]);
    if (mac) return mac;
  } catch {
    // Endereço não está na tabela de vizinhos.
  }

  return null;
}

function slugify(text) {
  return String(text || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 100) || "documento";
}

function uniqueFinalPath(title, sourceName) {
  const stem = slugify(title || sourceName.replace(/\.[^/.]+$/, ""));
  let candidate = resolve("okf/knowledge", `${stem}.md`);
  if (!existsSync(candidate)) return candidate;

  const suffix = createHash("sha256")
    .update(`${sourceName}:${Date.now()}`)
    .digest("hex")
    .slice(0, 8);
  candidate = resolve("okf/knowledge", `${stem}-${suffix}.md`);
  return candidate;
}

function safeArchiveName(fileName) {
  const cleaned = basename(fileName)
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .slice(0, 180);
  return `${Date.now()}-${cleaned || "arquivo"}`;
}

export const pipelineService = {
  async processUploadedFile(
    rawFilePath,
    clientIp,
    targetUsernameFolder = null,
    authenticatedUser = null,
  ) {
    const absoluteRawPath = resolve(rawFilePath);
    if (!existsSync(absoluteRawPath)) {
      return { success: false, error: "Arquivo de origem não encontrado." };
    }

    const fileName = basename(absoluteRawPath);
    const extension = extname(fileName).toLowerCase();

    let user = authenticatedUser;
    if (!user && targetUsernameFolder) {
      user = db.getUserByUsername(targetUsernameFolder);
    }
    if (!user) {
      user = db.getUserByIp(clientIp);
    }
    if (!user) {
      return {
        success: false,
        error: "Não foi possível associar o arquivo a um usuário pareado.",
      };
    }

    try {
      let extractedText = "";

      if (extension === ".pdf") {
        const pdfData = await pdfParse(readFileSync(absoluteRawPath));
        extractedText = pdfData.text;
      } else if ([".txt", ".md", ".markdown", ".csv", ".json"].includes(extension)) {
        extractedText = readFileSync(absoluteRawPath, "utf8");
      } else {
        extractedText =
          `Arquivo técnico binário. Nome: ${fileName}. ` +
          `Tamanho: ${readFileSync(absoluteRawPath).length} bytes.`;
      }

      if (!extractedText.trim()) {
        extractedText = `Arquivo técnico ${fileName} sem texto diretamente extraível.`;
      }

      const standardization = await geminiService.standardizeDocument({
        text: extractedText,
        fileName,
        author: user,
      });

      const finalPath = uniqueFinalPath(standardization.title, fileName);
      const finalFileName = basename(finalPath);
      writeFileSync(finalPath, standardization.markdown, {
        encoding: "utf8",
        mode: 0o600,
      });

      db.createDocument({
        path: `knowledge/${finalFileName}`,
        title: standardization.title,
        description: standardization.description,
        tags: standardization.tags,
        authorName: user.name,
        authorRole: user.role,
        sourceFile: fileName,
        uploadedByMac: user.mac,
      });

      const archivePath = resolve(
        "okf/uploads_raw/.archive",
        safeArchiveName(fileName),
      );
      renameSync(absoluteRawPath, archivePath);
      this.rebuildManifest();

      return {
        success: true,
        document: {
          path: `knowledge/${finalFileName}`,
          title: standardization.title,
          description: standardization.description,
          tags: standardization.tags,
          author: `${user.name} (${user.role})`,
        },
      };
    } catch (error) {
      console.error(`[Pipeline] Erro ao processar ${fileName}:`, error);
      return { success: false, error: error.message };
    }
  },

  rebuildManifest() {
    try {
      const documentsList = db.listDocuments();
      const manifest = {
        format: "engenharia-okf-manifest",
        publicContractVersion: "1.1.0",
        updatedAt: new Date().toISOString(),
        documents: documentsList.map(doc => ({
          path: doc.path,
          title: doc.title,
          description: doc.description,
          tags: doc.tags,
          author: `${doc.author_name} (${doc.author_role})`,
          source_file: doc.source_file,
          uploaded_at: doc.uploaded_at,
        })),
      };
      writeFileSync(
        "okf/manifest.json",
        JSON.stringify(manifest, null, 2),
        { encoding: "utf8", mode: 0o600 },
      );
    } catch (error) {
      console.error("[Pipeline] Erro ao reconstruir o manifesto:", error);
    }
  },

  async scanRawUploads() {
    // A varredura controlada permanece no server.js.
  },
};
