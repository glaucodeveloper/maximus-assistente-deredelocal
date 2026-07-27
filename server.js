import express from "express";
import https from "node:https";
import cors from "cors";
import dotenv from "dotenv";
import FtpServer from "ftp-srv";
import { resolve, join, basename } from "node:path";
import { mkdirSync, existsSync, readdirSync, statSync, writeFileSync, readFileSync, createWriteStream } from "node:fs";
import { db } from "./services/db.js";
import { pipelineService, getMacFromIp } from "./services/pipeline.js";
import { geminiService } from "./services/gemini.js";

dotenv.config();

const PORT = process.env.PORT || 3000;
const FTP_PORT = process.env.FTP_PORT || 2121;
const TLS_CERT_PATH = process.env.TLS_CERT_PATH || "";
const TLS_KEY_PATH = process.env.TLS_KEY_PATH || "";

// Garante pastas principais do OKF
mkdirSync("okf/knowledge", { recursive: true });
mkdirSync("okf/uploads_raw/.archive", { recursive: true });

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static("public"));

// Helper para obter informações estruturadas do usuário atual da requisição
function getRequestUser(req) {
  const ip = req.ip || req.socket.remoteAddress;
  let user = db.getUserByIp(ip);
  if (!user) {
    const mac = getMacFromIp(ip);
    // Retorna um usuário mockado não registrado para sinalizar ao frontend
    return { registered: false, ip, mac };
  }
  return { registered: true, ...user };
}

// ==========================================
// ROTEAMENTO DA API REST
// ==========================================

// Obter dados do usuário conectado
app.get("/api/user/me", (req, res) => {
  const user = getRequestUser(req);
  res.json(user);
});

// Registrar dispositivo/usuário
app.post("/api/user/register", (req, res) => {
  const { name, role, sector } = req.body;
  if (!name || !role || !sector) {
    return res.status(400).json({ error: "Campos name, role e sector são obrigatórios." });
  }

  const ip = req.ip || req.socket.remoteAddress;
  const mac = getMacFromIp(ip);

  const user = db.createUser({
    mac,
    ip: ip.replace(/^::ffff:/, ""),
    name,
    role,
    sector
  });

  // Cria a pasta privada do usuário no FTP uploads_raw
  const usernameFolder = name.toLowerCase().replace(/[^a-z0-9]+/g, "");
  mkdirSync(join("okf/uploads_raw", usernameFolder), { recursive: true });

  console.log(`[Server] Dispositivo registrado: ${name} (IP: ${ip}, MAC: ${mac})`);
  res.json({ success: true, user });
});

// Listar todos os usuários cadastrados
app.get("/api/user/list", (req, res) => {
  res.json(db.listUsers());
});

// Solicitar permissão para pasta de outro usuário
app.post("/api/permissions/request", (req, res) => {
  const user = getRequestUser(req);
  if (!user.registered) return res.status(401).json({ error: "Dispositivo não registrado." });

  const { targetUsername } = req.body;
  if (!targetUsername) return res.status(400).json({ error: "Nome da pasta alvo é obrigatório." });

  db.createPermissionRequest({
    requesterMac: user.mac,
    targetUsername: targetUsername.toLowerCase()
  });

  res.json({ success: true, message: "Solicitação enviada com sucesso." });
});

// Responder a pedido de permissão (Dono da pasta responde)
app.post("/api/permissions/respond", (req, res) => {
  const user = getRequestUser(req);
  if (!user.registered) return res.status(401).json({ error: "Dispositivo não registrado." });

  const { id, status } = req.body; // status: 'approved' ou 'rejected'
  if (!id || !status) return res.status(400).json({ error: "Campos id e status são obrigatórios." });

  db.updatePermissionStatus(id, status);
  res.json({ success: true, message: `Solicitação atualizada para: ${status}` });
});

// Listar pedidos de permissão pendentes
app.get("/api/permissions/pending", (req, res) => {
  res.json(db.listPendingPermissions());
});

// Listar todas as permissões
app.get("/api/permissions", (req, res) => {
  res.json(db.listAllPermissions());
});

// Listar tarefas (tasks)
app.get("/api/tasks", (req, res) => {
  res.json(db.listTasks());
});

// Criar nova tarefa
app.post("/api/tasks", (req, res) => {
  const { title, description, assignedToMac } = req.body;
  if (!title || !description || !assignedToMac) {
    return res.status(400).json({ error: "Campos title, description e assignedToMac são obrigatórios." });
  }

  db.createTask({ title, description, assignedToMac });
  res.json({ success: true, message: "Tarefa criada com sucesso." });
});

// Atualizar status de tarefa
app.post("/api/tasks/:id/status", (req, res) => {
  const { id } = req.params;
  const { status } = req.body; // 'pending', 'in_progress', 'completed'
  if (!status) return res.status(400).json({ error: "Campo status é obrigatório." });

  db.updateTaskStatus(id, status);
  res.json({ success: true, message: "Status da tarefa atualizado." });
});

// Listar documentos padronizados do OKF
app.get("/api/documents", (req, res) => {
  res.json(db.listDocuments());
});

// Obter conteúdo de um documento específico
app.get("/api/documents/*", (req, res) => {
  const docPath = req.params[0]; // Caminho relativo como 'knowledge/exemplo.md'
  const absolutePath = resolve("okf", docPath);
  if (!existsSync(absolutePath) || absolutePath.includes("..")) {
    return res.status(404).json({ error: "Documento não encontrado." });
  }
  try {
    // Retorna raw text
    res.send(readFileSync(absolutePath, "utf8"));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Chat Inteligente RAG com documentos técnicos
app.post("/api/chat", async (req, res) => {
  const user = getRequestUser(req);
  if (!user.registered) return res.status(401).json({ error: "Dispositivo não registrado." });

  const { question } = req.body;
  if (!question) return res.status(400).json({ error: "A pergunta é obrigatória." });

  try {
    const documents = db.listDocuments();
    let finalContextDocs = [];
    let loadedDocs = [];

    if (documents.length > 0) {
      // Busca RAG simples: calcula interseção de termos para obter documentos relevantes
      const terms = question.toLowerCase().split(/\s+/).filter(t => t.length > 2);
      const rankedDocs = documents.map(doc => {
        let score = 0;
        const contentLower = `${doc.title} ${doc.description} ${doc.tags.join(" ")}`.toLowerCase();
        for (const term of terms) {
          if (contentLower.includes(term)) score += 1;
          if (doc.title.toLowerCase().includes(term)) score += 2; // Título tem mais peso
        }
        return { doc, score };
      })
      .filter(item => item.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 5) // Pega os top 5
      .map(item => item.doc);

      // Se não encontrou nenhuma interseção, passa os top 3 mais recentes como contexto de segurança
      finalContextDocs = rankedDocs.length > 0 ? rankedDocs : documents.slice(0, 3);

      // Carrega o conteúdo físico de cada arquivo markdown para enviar ao Gemini
      loadedDocs = finalContextDocs.map(doc => {
        try {
          const fullPath = resolve("okf", doc.path);
          const content = existsSync(fullPath) ? readFileSync(fullPath, "utf8") : "";
          return { ...doc, content };
        } catch (e) {
          return { ...doc, content: "" };
        }
      });
    }

    const answer = await geminiService.askEngineeringChat({
      question,
      contextDocs: loadedDocs,
      user
    });

    res.json({
      answer,
      sources: finalContextDocs.map(doc => ({
        title: doc.title,
        path: doc.path,
        author: `${doc.author_name} (${doc.author_role})`
      }))
    });
  } catch (e) {
    console.error("[Chat API Error]", e);
    res.status(500).json({ error: e.message });
  }
});

// Upload direto via Interface Web
app.post("/api/upload", (req, res) => {
  const user = getRequestUser(req);
  if (!user.registered) return res.status(401).json({ error: "Dispositivo não registrado." });

  const fileName = req.headers["x-filename"];
  const targetUserFolder = req.headers["x-user-folder"] || user.name.toLowerCase().replace(/[^a-z0-9]+/g, "");

  if (!fileName) return res.status(400).json({ error: "Cabeçalho X-Filename é obrigatório." });

  const userPath = join("okf/uploads_raw", targetUserFolder);
  mkdirSync(userPath, { recursive: true });

  const tempPath = join(userPath, fileName);
  const writeStream = createWriteStream(tempPath);

  req.pipe(writeStream);

  writeStream.on("finish", async () => {
    try {
      const result = await pipelineService.processUploadedFile(tempPath, req.ip, targetUserFolder);
      res.json(result);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  writeStream.on("error", (e) => {
    res.status(500).json({ error: e.message });
  });
});


// ==========================================
// SERVIDOR FTP INTEGRADO COM SEGURANÇA
// ==========================================

const ftpServer = new FtpServer({
  url: `ftp://0.0.0.0:${FTP_PORT}`,
  anonymous: true,
  greeting: "Servidor de Engenharia FTP - Sincronização OKF"
});

// Customiza o login para associar o diretório raiz e checar permissões
ftpServer.on("login", ({ connection, username, password }, resolveFtp, rejectFtp) => {
  const clientIp = connection.ip || connection.socket.remoteAddress;
  const user = db.getUserByIp(clientIp);

  // Todo mundo compartilha o mesmo root local físico, mas o comportamento
  // de gravação do FileSystem é restrito por usuário.
  const rootPath = resolve("okf/uploads_raw");
  mkdirSync(rootPath, { recursive: true });

  // Cria classe de FileSystem customizada para este cliente
  class SecureFileSystem extends FtpServer.FileSystem {
    constructor(conn, options) {
      super(conn, options);
      this.clientIp = clientIp;
      this.user = user;
    }

    _getOwnerOfPath(fileName) {
      const { clientPath } = this._resolvePath(fileName);
      const parts = clientPath.split("/").filter(Boolean);
      return parts[0] || null; // Nome da primeira pasta (pasta do dono)
    }

    // Intercepta operações de escrita, exclusão e alteração
    write(fileName, options) {
      const targetOwner = this._getOwnerOfPath(fileName);
      if (targetOwner && targetOwner !== ".archive") {
        const usernameFolder = this.user ? this.user.name.toLowerCase().replace(/[^a-z0-9]+/g, "") : null;
        const isOwnFolder = usernameFolder === targetOwner.toLowerCase();

        if (!isOwnFolder) {
          // Checa se o proprietário deu permissão
          const hasPermission = this.user ? db.checkPermission(this.user.mac, targetOwner) : null;
          if (!hasPermission) {
            // Solicita permissão de forma assíncrona gerando um evento pendente
            if (this.user) {
              db.createPermissionRequest({
                requesterMac: this.user.mac,
                targetUsername: targetOwner
              });
              console.log(`[FTP] Escrita negada em ${fileName} de ${this.clientIp}. Solicitação criada para ${targetOwner}.`);
            }
            return Promise.reject(new Error("PERMISSAO_NEGADA: Você não possui autorização de escrita para esta pasta."));
          }
        }
      }
      return super.write(fileName, options);
    }

    delete(path) {
      const targetOwner = this._getOwnerOfPath(path);
      if (targetOwner && targetOwner !== ".archive") {
        const usernameFolder = this.user ? this.user.name.toLowerCase().replace(/[^a-z0-9]+/g, "") : null;
        if (usernameFolder !== targetOwner.toLowerCase()) {
          return Promise.reject(new Error("PERMISSAO_NEGADA: Apenas o proprietário pode excluir arquivos desta pasta."));
        }
      }
      return super.delete(path);
    }

    rename(from, to) {
      const targetOwnerFrom = this._getOwnerOfPath(from);
      const targetOwnerTo = this._getOwnerOfPath(to);
      const usernameFolder = this.user ? this.user.name.toLowerCase().replace(/[^a-z0-9]+/g, "") : null;

      if ((targetOwnerFrom && targetOwnerFrom !== usernameFolder) || (targetOwnerTo && targetOwnerTo !== usernameFolder)) {
        return Promise.reject(new Error("PERMISSAO_NEGADA: Operação de renomeação cruzada restrita."));
      }
      return super.rename(from, to);
    }
  }

  // Resolve a autenticação FTP devolvendo a classe customizada
  resolveFtp({
    root: rootPath,
    fs: new SecureFileSystem(connection, { root: rootPath })
  });
});

// Listener de sucesso de escrita FTP (STOR) para acionar o pipeline imediatamente
ftpServer.on("client:connected", ({ connection }) => {
  const clientIp = connection.ip || connection.socket.remoteAddress;
  connection.on("stor", async (error, filePath) => {
    if (error) {
      console.error(`[FTP] Erro de STOR do IP ${clientIp}:`, error);
      return;
    }
    console.log(`[FTP] Arquivo recebido com sucesso via STOR: ${filePath}`);

    // Identifica o dono da pasta onde o arquivo foi salvo
    const parts = filePath.replace(/\\/g, "/").split("/").filter(Boolean);
    // Encontra o index do uploads_raw para pegar a subpasta
    const uploadsRawIdx = parts.indexOf("uploads_raw");
    const targetUserFolder = (uploadsRawIdx !== -1 && parts[uploadsRawIdx + 1] !== ".archive") ? parts[uploadsRawIdx + 1] : null;

    // Dispara processamento do pipeline em background
    setTimeout(async () => {
      await pipelineService.processUploadedFile(filePath, clientIp, targetUserFolder);
    }, 1000);
  });
});


// ==========================================
// LOOP DE VARREDURA PERIÓDICA (FALLBACK)
// ==========================================

async function periodicFolderScan() {
  const rootUploads = resolve("okf/uploads_raw");
  if (!existsSync(rootUploads)) return;

  try {
    const scanDir = (dirPath) => {
      const items = readdirSync(dirPath);
      for (const item of items) {
        if (item === ".archive") continue;
        const fullPath = join(dirPath, item);
        const stat = statSync(fullPath);

        if (stat.isDirectory()) {
          scanDir(fullPath);
        } else if (stat.isFile()) {
          // Arquivo solto detectado!
          // Verifica estabilidade do arquivo (tamanho fixo por 3 segundos para evitar ler arquivos em upload)
          const size1 = stat.size;
          setTimeout(() => {
            if (!existsSync(fullPath)) return;
            const size2 = statSync(fullPath).size;
            if (size1 === size2 && size1 > 0) {
              // Identifica a pasta do usuário baseado no caminho relativo
              const relativePath = fullPath.substring(rootUploads.length).replace(/\\/g, "/");
              const parts = relativePath.split("/").filter(Boolean);
              const targetUserFolder = parts[0] || null;

              // Processa arquivo pendente
              pipelineService.processUploadedFile(fullPath, "127.0.0.1", targetUserFolder);
            }
          }, 3000);
        }
      }
    };

    scanDir(rootUploads);
  } catch (e) {
    console.error("[Scan Error]", e);
  }
}


// Inicializa e reconstrói o manifest na subida do servidor
pipelineService.rebuildManifest();

// Inicia servidores
const tlsEnabled =
  TLS_CERT_PATH.length > 0 &&
  TLS_KEY_PATH.length > 0;

if (tlsEnabled) {
  if (!existsSync(TLS_CERT_PATH)) {
    throw new Error(`Certificado TLS não encontrado: ${TLS_CERT_PATH}`);
  }

  if (!existsSync(TLS_KEY_PATH)) {
    throw new Error(`Chave TLS não encontrada: ${TLS_KEY_PATH}`);
  }

  const tlsOptions = {
    cert: readFileSync(TLS_CERT_PATH),
    key: readFileSync(TLS_KEY_PATH)
  };

  https.createServer(tlsOptions, app).listen(
    PORT,
    "0.0.0.0",
    () => {
      console.log(
        `[Server] Web UI e REST API HTTPS rodando em https://0.0.0.0:${PORT}`
      );
    }
  );
} else {
  app.listen(PORT, "0.0.0.0", () => {
    console.log(
      `[Server] Web UI e REST API HTTP rodando em http://0.0.0.0:${PORT}`
    );
  });
}

ftpServer.listen().then(() => {
  console.log(`[Server] Servidor FTP rodando em ftp://0.0.0.0:${FTP_PORT}`);
});

// Varredura a cada 15 segundos
setInterval(periodicFolderScan, 15000);
