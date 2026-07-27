import { readFileSync, writeFileSync, mkdirSync, renameSync, existsSync } from "node:fs";
import { resolve, basename, extname } from "node:path";
import pdfParse from "pdf-parse";
import { db } from "./db.js";
import { geminiService } from "./gemini.js";

// Garante que diretórios do OKF existem
mkdirSync("okf/knowledge", { recursive: true });
mkdirSync("okf/uploads_raw/.archive", { recursive: true });

/**
 * Lê o arquivo /proc/net/arp no Linux para capturar o MAC Address associado ao IP do cliente.
 */
export function getMacFromIp(ip) {
  const normalizedIp = ip.replace(/^::ffff:/, "").trim();
  if (normalizedIp === "127.0.0.1" || normalizedIp === "::1" || normalizedIp === "localhost") {
    return "00:00:00:00:00:00"; // Localhost
  }
  try {
    const arpData = readFileSync("/proc/net/arp", "utf8");
    const lines = arpData.split("\n");
    for (const line of lines) {
      const parts = line.split(/\s+/);
      if (parts.length >= 4 && parts[0] === normalizedIp) {
        return parts[3].toLowerCase(); // MAC Address (e.g. 42:31:3b:f1:2b:08)
      }
    }
  } catch (e) {
    console.error(`[ARP] Não foi possível ler /proc/net/arp: ${e.message}`);
  }
  // Fallback determinístico para desenvolvimento local sem vizinhos ARP ativos
  const hex = Buffer.from(normalizedIp).toString("hex").slice(-12).padEnd(12, "0");
  const formatted = hex.match(/.{1,2}/g).join(":");
  return `02:00:00:${formatted.slice(9)}`;
}

/**
 * Gera um nome amigável para a url (slug)
 */
function slugify(text) {
  return text
    .toString()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "") // Remove acentos
    .replace(/[^a-z0-9]+/g, "-") // Substitui espaços e especiais por hifens
    .replace(/^-+|-+$/g, ""); // Remove hifens no início ou fim
}

export const pipelineService = {
  /**
   * Processa e padroniza um arquivo de upload bruto.
   */
  async processUploadedFile(rawFilePath, clientIp, targetUsernameFolder = null) {
    console.log(`[Pipeline] Processando arquivo: ${rawFilePath} de IP: ${clientIp}`);
    const fileName = basename(rawFilePath);
    const extension = extname(fileName).toLowerCase();

    // 1. Identifica o Usuário associado ao IP
    let user = db.getUserByIp(clientIp);
    if (!user) {
      // Se não houver usuário cadastrado naquele IP, busca o usuário associado à pasta destino
      if (targetUsernameFolder) {
        user = db.getUserByUsername(targetUsernameFolder);
      }

      // Se ainda sim não houver, cria um perfil genérico temporário
      if (!user) {
        const mac = getMacFromIp(clientIp);
        user = db.createUser({
          mac,
          ip: clientIp,
          name: targetUsernameFolder || `Usuário de ${clientIp.replace(/^::ffff:/, "")}`,
          role: "Colaborador",
          sector: "Geral"
        });
      }
    }

    try {
      let extractedText = "";

      // 2. Extrai texto de acordo com a extensão do arquivo
      if (extension === ".pdf") {
        const fileBuffer = readFileSync(rawFilePath);
        const pdfData = await pdfParse(fileBuffer);
        extractedText = pdfData.text;
      } else if (extension === ".txt" || extension === ".md") {
        extractedText = readFileSync(rawFilePath, "utf8");
      } else {
        // Para arquivos não textuais ou desconhecidos, cria um documento apenas com metadados do arquivo original
        extractedText = `Arquivo binário técnico enviado. Nome: ${fileName}. Tamanho: ${readFileSync(rawFilePath).length} bytes.`;
      }

      if (!extractedText || extractedText.trim().length === 0) {
        extractedText = `Arquivo técnico ${fileName} sem conteúdo legível por texto direto.`;
      }

      // 3. Executa padronização com Gemini IA
      const standardization = await geminiService.standardizeDocument({
        text: extractedText,
        fileName,
        author: user
      });

      // 4. Salva o novo arquivo markdown final padronizado no diretório OKF
      const slugTitle = slugify(standardization.title || fileName.replace(/\.[^/.]+$/, ""));
      const finalFileName = `${slugTitle}.md`;
      const finalPath = resolve("okf/knowledge", finalFileName);

      writeFileSync(finalPath, standardization.markdown, "utf8");
      console.log(`[Pipeline] Documento padronizado salvo: ${finalPath}`);

      // 5. Registra o documento no banco de dados SQLite
      db.createDocument({
        path: `knowledge/${finalFileName}`,
        title: standardization.title,
        description: standardization.description,
        tags: standardization.tags,
        authorName: user.name,
        authorRole: user.role,
        sourceFile: fileName,
        uploadedByMac: user.mac
      });

      // 6. Move o arquivo original para o diretório .archive para limpar a pasta FTP de uploads ativos
      const archivePath = resolve("okf/uploads_raw/.archive", `${Date.now()}-${fileName}`);
      renameSync(rawFilePath, archivePath);
      console.log(`[Pipeline] Arquivo bruto arquivado em: ${archivePath}`);

      // 7. Atualiza o manifesto central do OKF para acesso rápido e compatibilidade
      this.rebuildManifest();

      return {
        success: true,
        document: {
          path: `knowledge/${finalFileName}`,
          title: standardization.title,
          description: standardization.description,
          tags: standardization.tags,
          author: `${user.name} (${user.role})`
        }
      };
    } catch (e) {
      console.error(`[Pipeline] Erro ao processar arquivo ${fileName}:`, e);
      return { success: false, error: e.message };
    }
  },

  /**
   * Reconstrói o manifest.json unificado dos documentos OKF para busca e indexação rápidos.
   */
  rebuildManifest() {
    try {
      const documentsList = db.listDocuments();
      const manifest = {
        format: "engenharia-okf-manifest",
        publicContractVersion: "1.0.0",
        updatedAt: new Date().toISOString(),
        documents: documentsList.map(doc => ({
          path: doc.path,
          title: doc.title,
          description: doc.description,
          tags: doc.tags,
          author: `${doc.author_name} (${doc.author_role})`,
          source_file: doc.source_file,
          uploaded_at: doc.uploaded_at
        }))
      };

      writeFileSync("okf/manifest.json", JSON.stringify(manifest, null, 2), "utf8");
      console.log(`[Pipeline] Manifesto OKF atualizado com sucesso. Total documentos: ${documentsList.length}`);
    } catch (e) {
      console.error("[Pipeline] Erro ao criar manifesto OKF:", e);
    }
  },

  /**
   * Varre periodicamente a pasta okf/uploads_raw e processa qualquer arquivo pendente.
   * Útil para pegar arquivos que foram gravados diretamente no FTP sem disparar o evento,
   * ou se o servidor FTP foi reiniciado durante um upload parcial.
   */
  async scanRawUploads() {
    // Implementado no loop secundário do server.js
  }
};
