import {
  generateTransformersText,
  hasCompleteMarker,
  prepareTransformersModel,
} from "../src/client/transformers-runtime.js";

// AUTENTICAÇÃO LOCAL: token de acesso vinculado ao endereço da máquina
const DEVICE_TOKEN_KEY = "engenharia.device.access-token";
const nativeFetch = window.fetch.bind(window);

async function apiFetch(input, init = {}) {
  const headers = new Headers(init.headers || {});
  const token = localStorage.getItem(DEVICE_TOKEN_KEY);
  if (token) headers.set("Authorization", `Bearer ${token}`);

  const response = await nativeFetch(input, { ...init, headers });
  if (response.status === 401 && token) {
    localStorage.removeItem(DEVICE_TOKEN_KEY);
  }
  return response;
}

// CENTRAL DE ENGENHARIA — FRONTEND COM ARQUITETURA STATIC NEXT (SEM HELPER / BINDER)

function* AppGenerator({ id }) {
  this.id = id;
  this.element = null;

  // Estado inicial completo do app
  this.state = {
    user: null,               // { registered: false, ip: '...', mac: '...' } ou o perfil completo
    activeTab: "dashboard",   // "dashboard" (chat ia + docs), "ftp" (pastas ftp), "tasks" (atividades)
    documents: [],            // lista de documentos cadastrados
    searchQuery: "",          // filtro de pesquisa de docs
    chatMessages: [
      {
        id: "welcome",
        sender: "ai",
        name: "IA Assistente",
        text: "Olá! Eu sou o Assistente IA de Engenharia da rede local.\n\nEstou pronto para ajudar você a analisar documentos, validar tabelas técnicas e responder qualquer dúvida técnica da equipe.\n\nTente enviar arquivos PDF técnicos ou faça perguntas específicas sobre nossos padrões."
      }
    ],
    chatInputText: "",
    isTyping: false,
    usersList: [],            // todos os usuários cadastrados
    pendingPermissions: [],   // permissões pendentes (recebidas)
    allPermissions: [],       // todas as permissões do sistema
    tasks: [],                // quadro de atividades
    selectedDocContent: null, // conteúdo do doc ativo no modal
    selectedDocTitle: null,
    selectedDocMeta: null,
    isUploading: false,
    taskTitle: "",
    taskDesc: "",
    taskAssignedMac: "",
    modelReady: false,
    modelPreparing: false,
    modelProgress: 0,
    modelError: "",
    modelStatus: "Verificando o cache local..."
  };

  // --- MÉTODOS ASSÍNCRONOS (PADRÃO NÍVEL 7 - DISPARAM PATCH NO RETORNO) ---

  this.checkUserStatus = async () => {
    try {
      const res = await apiFetch("/api/user/me");
      if (res.ok) {
        const user = await res.json();
        this.next({ user });
        this.loadInitialData();
        this.prepareLocalModel();
        return;
      }

      const statusRes = await nativeFetch("/api/device/status");
      const status = await statusRes.json();
      this.next({
        user: {
          registered: false,
          ip: status.ip,
          mac: status.machineAddress,
          machineAddress: status.machineAddress,
          addressAvailable: status.addressAvailable
        }
      });
    } catch (e) {
      console.error("Erro ao checar status do dispositivo:", e);
      this.next({
        user: {
          registered: false,
          ip: "-",
          mac: null,
          machineAddress: null,
          addressAvailable: false
        }
      });
    }
  };

  this.registerUser = async (pairingToken, name, role, sector) => {
    try {
      const res = await nativeFetch("/api/user/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pairingToken, name, role, sector })
      });
      const data = await res.json();
      if (data.success) {
        localStorage.setItem(DEVICE_TOKEN_KEY, data.accessToken);
        this.next({ user: { registered: true, ...data.user } });
        this.loadInitialData();
        this.prepareLocalModel();

        if (data.ftp?.enabled) {
          window.prompt(
            `Pareamento concluído. Copie agora a senha FTPS do usuário ${data.ftp.username}:`,
            data.accessToken
          );
        }
      } else {
        alert("Erro ao parear dispositivo: " + data.error);
      }
    } catch (e) {
      console.error("Erro ao parear:", e);
      alert("Não foi possível concluir o pareamento.");
    }
  };

  this.prepareLocalModel = async () => {
    if (this.state.modelReady || this.state.modelPreparing) return;

    this.next({
      modelPreparing: true,
      modelProgress: 0,
      modelError: "",
      modelStatus: "Verificando o cache local..."
    });

    try {
      const cached = await hasCompleteMarker();

      if (!cached) {
        await prepareTransformersModel({
          onProgress: progress => {
            const labels = {
              "worker-ready": "Inicializando o worker...",
              "runtime-import": "Carregando Transformers.js...",
              "fallback-main": "Worker indisponível; usando modo compatível...",
              connection: "Conectando ao Hugging Face...",
              connected: "Conexão estabelecida.",
              initiate: "Preparando o arquivo...",
              download: "Iniciando download...",
              progress: "Baixando o modelo...",
              done: "Arquivo concluído.",
              ready: "Inteligência pronta."
            };

            const file = progress.file
              ? ` ${progress.file}`
              : "";

            this.next({
              modelPreparing: true,
              modelProgress: progress.percent || 0,
              modelError: "",
              modelStatus:
                `${labels[progress.status] || "Preparando..."}${file}`
            });
          }
        });
      }

      this.next({
        modelReady: true,
        modelPreparing: false,
        modelProgress: 100,
        modelError: "",
        modelStatus: "Inteligência local pronta."
      });
    } catch (error) {
      console.error("Erro ao preparar inteligência local:", error);
      this.next({
        modelReady: false,
        modelPreparing: false,
        modelError: error.message || "Falha ao baixar o modelo local.",
        modelStatus: "Preparação interrompida."
      });
    }
  };

  this.loadInitialData = () => {
    this.loadDocuments();
    this.loadUsersList();
    this.loadPermissions();
    this.loadTasks();
  };

  this.loadDocuments = async () => {
    try {
      const res = await apiFetch("/api/documents");
      const docs = await res.json();
      this.next({ documents: docs });
    } catch (e) {
      console.error("Erro ao carregar documentos:", e);
    }
  };

  this.loadUsersList = async () => {
    try {
      const res = await apiFetch("/api/user/list");
      const list = await res.json();
      this.next({ usersList: list });
    } catch (e) {
      console.error("Erro ao carregar lista de usuários:", e);
    }
  };

  this.loadPermissions = async () => {
    try {
      const pRes = await apiFetch("/api/permissions/pending");
      const pending = await pRes.json();
      const aRes = await apiFetch("/api/permissions");
      const all = await aRes.json();
      this.next({ pendingPermissions: pending, allPermissions: all });
    } catch (e) {
      console.error("Erro ao carregar permissões:", e);
    }
  };

  this.loadTasks = async () => {
    try {
      const res = await apiFetch("/api/tasks");
      const list = await res.json();
      this.next({ tasks: list });
    } catch (e) {
      console.error("Erro ao carregar tarefas:", e);
    }
  };

  this.switchTab = (tab) => {
    this.next({ activeTab: tab });
    if (tab === "ftp") this.loadPermissions();
    if (tab === "tasks") this.loadTasks();
  };

  this.setSearch = (query) => {
    this.next({ searchQuery: query });
  };

  this.viewDocument = async (docPath) => {
    try {
      const res = await apiFetch(`/api/documents/${docPath}`);
      if (!res.ok) throw new Error("Documento indisponível ou inacessível.");
      const content = await res.text();
      const doc = this.state.documents.find(d => d.path === docPath) || { title: "Documento", tags: [], author_name: "-", author_role: "-" };

      this.next({
        selectedDocContent: content,
        selectedDocTitle: doc.title,
        selectedDocMeta: `Autor: ${doc.author_name} (${doc.author_role}) • Tags: ${doc.tags.join(", ")}`
      });
    } catch (e) {
      alert("Erro ao ler documento: " + e.message);
    }
  };

  this.closeDocument = () => {
    this.next({ selectedDocContent: null, selectedDocTitle: null, selectedDocMeta: null });
  };

  this.submitChat = async (question) => {
    if (!question.trim() || this.state.isTyping) return;

    const userMsg = {
      id: "msg-" + Date.now(),
      sender: "user",
      name: this.state.user.name,
      text: question
    };

    const priorMessages = this.state.chatMessages;

    this.next({
      chatMessages: [...priorMessages, userMsg],
      chatInputText: "",
      isTyping: true
    });

    try {
      if (!this.state.modelReady) {
        await this.prepareLocalModel();
      }

      if (!this.state.modelReady) {
        throw new Error(
          this.state.modelError ||
          "A inteligência local ainda não está pronta."
        );
      }

      const res = await apiFetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question })
      });

      const result = await res.json();
      if (!res.ok) {
        throw new Error(result.error || "Não foi possível preparar o contexto.");
      }

      const generated = await generateTransformersText(
        result.messages,
        { maxNewTokens: 96 }
      );

      const aiMsg = {
        id: "msg-ai-" + Date.now(),
        sender: "ai",
        name: "IA Assistente",
        text: generated.text || "O modelo não retornou texto.",
        sources: result.sources || []
      };

      this.next({
        chatMessages: [...priorMessages, userMsg, aiMsg],
        isTyping: false
      });
    } catch (error) {
      this.next({
        chatMessages: [
          ...priorMessages,
          userMsg,
          {
            id: "msg-err-" + Date.now(),
            sender: "ai",
            name: "IA Assistente",
            text: `Erro ao executar a inteligência local: ${error.message}`
          }
        ],
        isTyping: false
      });
    }
  };

  this.updateChatInput = (text) => {
    /*
     * Mantém o valor sem renderizar novamente o formulário. Uma
     * renderização no blur removia o botão antes do evento click.
     */
    this.state.chatInputText = text;
  };

  this.requestPermission = async (targetFolder) => {
    try {
      const res = await apiFetch("/api/permissions/request", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ targetUsername: targetFolder })
      });
      const data = await res.json();
      if (data.success) {
        alert("Pedido de permissão enviado. Aguarde liberação do proprietário.");
        this.loadPermissions();
      } else {
        alert("Erro ao solicitar: " + data.error);
      }
    } catch (e) {
      console.error(e);
    }
  };

  this.respondPermission = async (reqId, status) => {
    try {
      const res = await apiFetch("/api/permissions/respond", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: reqId, status })
      });
      const data = await res.json();
      if (data.success) {
        this.loadPermissions();
      } else {
        alert("Erro ao responder: " + data.error);
      }
    } catch (e) {
      console.error(e);
    }
  };

  this.uploadFile = async (file, targetFolder) => {
    this.next({ isUploading: true });
    try {
      const res = await apiFetch("/api/upload", {
        method: "POST",
        headers: {
          "X-Filename": file.name,
          "X-User-Folder": targetFolder
        },
        body: file
      });
      const result = await res.json();
      if (result.success) {
        alert(`Arquivo "${file.name}" padronizado com sucesso!`);
        this.switchTab("dashboard");
        this.loadDocuments();
      } else {
        alert(`Erro de processamento: ` + result.error);
      }
    } catch (e) {
      alert("Erro de conexão no upload.");
    } finally {
      this.next({ isUploading: false });
    }
  };

  this.updateTaskField = (field, value) => {
    const patch = {};
    patch[field] = value;
    this.next(patch);
  };

  this.createTask = async () => {
    const { taskTitle, taskDesc, taskAssignedMac } = this.state;
    if (!taskTitle.trim() || !taskDesc.trim() || !taskAssignedMac) {
      alert("Por favor, preencha todos os campos da atividade técnica.");
      return;
    }

    try {
      const res = await apiFetch("/api/tasks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: taskTitle,
          description: taskDesc,
          assignedToMac: taskAssignedMac
        })
      });
      const data = await res.json();
      if (data.success) {
        this.next({ taskTitle: "", taskDesc: "", taskAssignedMac: "" });
        this.loadTasks();
      } else {
        alert("Erro ao criar atividade: " + data.error);
      }
    } catch (e) {
      console.error(e);
    }
  };

  this.updateTaskStatus = async (taskId, status) => {
    try {
      const res = await apiFetch(`/api/tasks/${taskId}/status`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status })
      });
      const data = await res.json();
      if (data.success) {
        this.loadTasks();
      }
    } catch (e) {
      console.error(e);
    }
  };

  // Aciona primeira checagem de usuário imediatamente
  setTimeout(this.checkUserStatus, 0);

  // --- PARSE DE MARKDOWN BÁSICO NATIVO ---
  const escapeHtml = (value) => String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");

  const renderMarkdown = (md) => {
    let html = escapeHtml(md)
      .replace(/^---[\s\S]*?---/g, "") // Remove YAML frontmatter
      .replace(/# (.*)/g, '<h1 class="text-xl font-bold text-slate-900 border-b pb-2 mb-4 mt-6">$1</h1>')
      .replace(/## (.*)/g, '<h2 class="text-base font-bold text-slate-800 mb-2 mt-5">$1</h2>')
      .replace(/### (.*)/g, '<h3 class="text-sm font-bold text-slate-700 mb-2 mt-4">$1</h3>')
      .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
      .replace(/\*(.*?)\*/g, '<em>$1</em>')
      .replace(/- (.*)/g, '<li class="ml-4 list-disc text-xs text-slate-700">$1</li>')
      .replace(/\n\n/g, "<p class='mb-3 text-xs leading-relaxed text-slate-700'></p>");

    return `<div class="prose max-w-none text-xs leading-relaxed">${html}</div>`;
  };

  // --- RENDER LOOP INFINITO ---
  while (true) {
    const s = this.state;

    // Componentes condicionais derivados de estado
    const showRegister = s.user && !s.user.registered;
    const showModelSetup =
      s.user && s.user.registered && !s.modelReady;
    const isDashboard = s.activeTab === "dashboard";
    const isFtp = s.activeTab === "ftp";
    const isTasks = s.activeTab === "tasks";

    // Filtro de documentos
    const filteredDocs = s.documents.filter(doc => {
      const q = s.searchQuery.toLowerCase();
      if (!q) return true;
      return doc.title.toLowerCase().includes(q) ||
             doc.description.toLowerCase().includes(q) ||
             doc.tags.some(t => t.toLowerCase().includes(q)) ||
             doc.author_name.toLowerCase().includes(q);
    });

    // Filtra pedidos recebidos para a própria pasta do usuário ativo
    const myFolderName = s.user && s.user.name ? s.user.name.toLowerCase().replace(/[^a-z0-9]+/g, "") : "";
    const myPendingPermissions = s.pendingPermissions.filter(r => r.target_username === myFolderName);

    // Contagem de atividades pendentes
    const pendingTasksCount = s.tasks.filter(t => t.status === "pending").length;

    // HTML Rendering completo do App
    Object.assign(
      this.state,
      yield (this.element = ((element) => {
        element.id = this.id;
        element.component = this;

        // Executa re-render ou replace no DOM se conectado
        if (this.element?.isConnected) {
          this.element.replaceWith(element);
        }

        // Hydrata os ícones do Lucide após montagem no DOM
        setTimeout(() => window.lucide && window.lucide.createIcons(), 0);

        // Scroll do chat para o fundo após render se houver mensagens novas
        setTimeout(() => {
          const mBox = element.querySelector("#chat-messages-box");
          if (mBox) mBox.scrollTop = mBox.scrollHeight;
        }, 0);

        return element;
      })(Object.assign(document.createElement("template"), {
        innerHTML: /* html */ `
          <div class="flex flex-col min-h-screen w-full">

            <!-- OVERLAY DE CADASTRO OBRIGATÓRIO (Condicional) -->
            <div class="fixed inset-0 bg-slate-900/80 backdrop-blur-sm z-50 flex items-center justify-center p-4 ${showRegister ? '' : 'hidden'}">
              <div class="bg-white rounded-2xl shadow-2xl max-w-md w-full p-8 border border-slate-100 flex flex-col">
                <div class="flex items-center gap-3 mb-6">
                  <div class="w-12 h-12 rounded-xl bg-blue-600 text-white flex items-center justify-center shrink-0">
                    <i data-lucide="shield-alert" class="w-6 h-6"></i>
                  </div>
                  <div>
                    <h2 class="text-xl font-bold text-slate-900">Novo Dispositivo</h2>
                    <p class="text-xs text-slate-500">Cadastre seu perfil de Engenharia</p>
                  </div>
                </div>
                <div class="space-y-4 mb-6">
                  <div>
                    <label class="block text-xs font-bold text-slate-700 mb-1">Seu Nome Completo</label>
                    <input id="reg-name" type="text" placeholder="Ex: Carlos Silva" class="w-full px-4 py-3 rounded-xl border border-slate-200 focus:outline-none focus:ring-2 focus:ring-blue-500 text-xs">
                  </div>
                  <div>
                    <label class="block text-xs font-bold text-slate-700 mb-1">Cargo / Função de Engenharia</label>
                    <select id="reg-role" class="w-full px-4 py-3 rounded-xl border border-slate-200 focus:outline-none focus:ring-2 focus:ring-blue-500 text-xs text-slate-600 bg-white">
                      <option value="Engenheiro Civil">Engenheiro Civil</option>
                      <option value="Engenheiro de Estruturas">Engenheiro de Estruturas</option>
                      <option value="Engenheiro Eletricista">Engenheiro Eletricista</option>
                      <option value="Engenheiro Hidráulico">Engenheiro Hidráulico</option>
                      <option value="Projetista">Projetista</option>
                      <option value="Orçamentista">Orçamentista</option>
                      <option value="Mestre de Obras">Mestre de Obras</option>
                      <option value="Coordenador de Projetos">Coordenador de Projetos</option>
                      <option value="Estagiário de Engenharia">Estagiário de Engenharia</option>
                      <option value="Outro">Outro</option>
                    </select>
                  </div>
                  <div>
                    <label class="block text-xs font-bold text-slate-700 mb-1">Setor</label>
                    <select id="reg-sector" class="w-full px-4 py-3 rounded-xl border border-slate-200 focus:outline-none focus:ring-2 focus:ring-blue-500 text-xs text-slate-600 bg-white">
                      <option value="Civil / Infraestrutura">Civil / Infraestrutura</option>
                      <option value="Instalações Elétricas">Instalações Elétricas</option>
                      <option value="Instalações Hidráulicas">Instalações Hidráulicas</option>
                      <option value="Planejamento e Orçamento">Planejamento e Orçamento</option>
                      <option value="Segurança do Trabalho">Segurança do Trabalho</option>
                      <option value="Geral">Geral / Administrativo</option>
                    </select>
                  </div>
                  <div>
                    <label class="block text-xs font-bold text-slate-700 mb-1">Token de Pareamento</label>
                    <input id="reg-pairing-token" type="password" autocomplete="one-time-code" placeholder="mxp_..." class="w-full px-4 py-3 rounded-xl border border-slate-200 focus:outline-none focus:ring-2 focus:ring-blue-500 text-xs font-mono">
                    <p class="text-[10px] text-slate-500 mt-1">O token é usado uma vez e fica vinculado ao endereço desta máquina.</p>
                  </div>
                  <div class="p-3 bg-slate-50 rounded-xl border border-slate-100 flex flex-col gap-1 text-[10px] text-slate-500 font-mono">
                    <div class="flex justify-between"><span>IP:</span><span>${s.user ? s.user.ip : '-'}</span></div>
                    <div class="flex justify-between"><span>Endereço:</span><span>${s.user ? (s.user.machineAddress || s.user.mac || "-") : "-"}</span></div>
                  </div>
                </div>
                <button onclick="const el = document.getElementById('${this.id}').component; el.registerUser(document.getElementById('reg-pairing-token').value, document.getElementById('reg-name').value, document.getElementById('reg-role').value, document.getElementById('reg-sector').value)" class="w-full bg-blue-600 hover:bg-blue-700 text-white font-semibold py-3 rounded-xl transition duration-200 flex items-center justify-center gap-2 shadow-lg shadow-blue-500/10 text-xs">
                  <i data-lucide="check" class="w-4 h-4"></i> Concluir Cadastro
                </button>
              </div>
            </div>

            <!-- PREPARAÇÃO DA INTELIGÊNCIA LOCAL -->
            <div class="fixed inset-0 bg-slate-950/85 backdrop-blur-sm z-40 flex items-center justify-center p-4 ${showModelSetup ? '' : 'hidden'}">
              <div class="bg-white rounded-2xl shadow-2xl max-w-lg w-full p-8 border border-slate-100">
                <div class="flex items-center gap-3 mb-5">
                  <div class="w-12 h-12 rounded-xl bg-indigo-600 text-white flex items-center justify-center">
                    <i data-lucide="brain-circuit" class="w-6 h-6"></i>
                  </div>
                  <div>
                    <h2 class="text-lg font-bold text-slate-900">Inteligência local</h2>
                    <p class="text-xs text-slate-500">Gemma 3 1B Q4 · CPU/WebAssembly</p>
                  </div>
                </div>

                <p class="text-xs leading-relaxed text-slate-600 mb-5">
                  O modelo é baixado uma vez neste navegador, armazenado em cache
                  persistente e executado localmente. Versão Q4 otimizada, com aproximadamente 900 MB.
                </p>

                <div class="h-3 rounded-full bg-slate-200 overflow-hidden mb-2">
                  <div class="h-full bg-indigo-600 transition-all duration-300" style="width: ${Math.max(0, Math.min(100, s.modelProgress || 0))}%"></div>
                </div>

                <div class="flex justify-between text-[10px] text-slate-500 mb-5">
                  <span>${s.modelStatus || (s.modelPreparing ? "Baixando e preparando..." : "Verificando cache...")}</span>
                  <span>${s.modelProgress || 0}%</span>
                </div>

                ${s.modelError ? `
                  <div class="text-xs text-red-700 bg-red-50 border border-red-200 rounded-xl p-3 mb-4">
                    ${s.modelError}
                  </div>
                  <button onclick="document.getElementById('${this.id}').component.prepareLocalModel()" class="w-full bg-indigo-600 hover:bg-indigo-700 text-white font-semibold py-3 rounded-xl text-xs">
                    Tentar novamente
                  </button>
                ` : ""}
              </div>
            </div>

            <!-- HEADER -->
            <header class="bg-slate-900 text-white border-b border-slate-800 shrink-0 shadow-lg">
              <div class="max-w-[1800px] mx-auto px-6 py-4 flex items-center justify-between">
                <div class="flex items-center gap-3">
                  <div class="w-10 h-10 rounded-xl bg-blue-600 flex items-center justify-center shadow-lg shadow-blue-500/20">
                    <i data-lucide="cpu" class="w-5 h-5 text-white"></i>
                  </div>
                  <div>
                    <h1 class="text-sm font-bold leading-none tracking-wide">ENGENHARIA</h1>
                    <p class="text-[9px] text-blue-400 font-semibold tracking-widest mt-1 uppercase">SISTEMA INTEGRADO DE DOCUMENTAÇÃO & IA</p>
                  </div>
                </div>

                <!-- User Badge & Tabs -->
                <div class="flex items-center gap-4">
                  <div class="flex items-center gap-3 bg-slate-800/80 px-4 py-2 rounded-xl border border-slate-700/50">
                    <div class="w-8 h-8 rounded-full bg-gradient-to-tr from-blue-600 to-indigo-600 flex items-center justify-center shrink-0">
                      <i data-lucide="user" class="w-4 h-4 text-white"></i>
                    </div>
                    <div class="text-left leading-tight">
                      <p class="text-xs font-bold text-slate-100">${s.user && s.user.registered ? s.user.name : "Carregando..."}</p>
                      <p class="text-[9px] text-slate-400">${s.user && s.user.registered ? s.user.role : "Buscando IP..."}</p>
                    </div>
                  </div>

                  <!-- Navegação -->
                  <div class="flex items-center bg-slate-800 p-1 rounded-xl border border-slate-700/60 text-[11px] font-semibold">
                    <button onclick="document.getElementById('${this.id}').component.switchTab('dashboard')" class="px-4 py-2 rounded-lg transition flex items-center gap-1.5 ${isDashboard ? 'bg-blue-600 text-white' : 'text-slate-300 hover:text-white'}">
                      <i data-lucide="layout" class="w-3.5 h-3.5"></i> Dashboard
                    </button>
                    <button onclick="document.getElementById('${this.id}').component.switchTab('ftp')" class="px-4 py-2 rounded-lg transition flex items-center gap-1.5 ${isFtp ? 'bg-blue-600 text-white' : 'text-slate-300 hover:text-white'}">
                      <i data-lucide="folder-git-2" class="w-3.5 h-3.5"></i> Áreas FTP
                    </button>
                    <button onclick="document.getElementById('${this.id}').component.switchTab('tasks')" class="px-4 py-2 rounded-lg transition flex items-center gap-1.5 relative ${isTasks ? 'bg-blue-600 text-white' : 'text-slate-300 hover:text-white'}">
                      <i data-lucide="list-todo" class="w-3.5 h-3.5"></i> Atividades
                      <span class="absolute -top-1 -right-1 bg-red-500 text-white text-[9px] w-4 h-4 rounded-full flex items-center justify-center ${pendingTasksCount > 0 ? '' : 'hidden'}">${pendingTasksCount}</span>
                    </button>
                  </div>
                </div>
              </div>
            </header>

            <!-- MAIN WORKSPACE -->
            <main class="flex-1 max-w-[1800px] w-full mx-auto p-6 flex gap-6 overflow-hidden min-h-0">

              <!-- SEÇÃO ESQUERDA: CATÁLOGO OKF (Sempre visível no Dashboard, oculta nas outras TABS) -->
              <section class="w-1/2 flex flex-col gap-6 h-full min-h-0 transition-all duration-300 ${isDashboard ? '' : 'hidden'}">
                <!-- Filtros -->
                <div class="bg-white rounded-2xl p-5 shadow-sm border border-slate-100 flex flex-col gap-4 shrink-0">
                  <div class="flex justify-between items-center">
                    <h3 class="text-xs font-bold text-slate-900 flex items-center gap-1.5">
                      <i data-lucide="book-open" class="w-4 h-4 text-blue-600"></i> Base de Conhecimento OKF
                    </h3>
                    <span class="text-[10px] bg-slate-100 text-slate-600 px-2.5 py-1 rounded-full font-bold">${s.documents.length} documento${s.documents.length !== 1 ? 's' : ''}</span>
                  </div>
                  <div class="flex gap-2">
                    <div class="relative flex-1">
                      <i data-lucide="search" class="w-4 h-4 text-slate-400 absolute left-3.5 top-3.5"></i>
                      <input type="text" placeholder="Buscar documentos padronizados..." value="${s.searchQuery}" onblur="document.getElementById('${this.id}').component.setSearch(this.value)" class="w-full pl-10 pr-4 py-2.5 bg-slate-50 rounded-xl border border-slate-200 text-xs focus:outline-none focus:ring-2 focus:ring-blue-500 text-slate-700">
                    </div>
                    <button onclick="document.getElementById('${this.id}').component.loadDocuments()" class="p-2.5 border border-slate-200 rounded-xl hover:bg-slate-50 text-slate-600 hover:text-slate-900 transition shrink-0">
                      <i data-lucide="refresh-cw" class="w-4 h-4"></i>
                    </button>
                  </div>
                </div>

                <!-- Lista de Documentos -->
                <div class="flex-1 overflow-y-auto custom-scrollbar space-y-3 pr-2 min-h-0">
                  ${filteredDocs.length === 0 ? `
                    <div class="bg-white rounded-xl p-8 text-center text-slate-400 border border-slate-100">
                      <i data-lucide="folder-open" class="w-12 h-12 mx-auto mb-3 opacity-40"></i>
                      <p class="text-sm font-medium">Nenhum documento encontrado.</p>
                      <p class="text-xs text-slate-500 mt-1">Sincronize arquivos via FTP ou faça um upload manual na aba Áreas FTP para começar.</p>
                    </div>
                  ` : filteredDocs.map(doc => `
                    <div class="bg-white rounded-xl p-5 border border-slate-100 hover:border-blue-300 hover:shadow-md transition duration-200 flex flex-col gap-3">
                      <div class="flex justify-between items-start">
                        <div class="flex items-center gap-2">
                          <div class="w-8 h-8 rounded-lg bg-blue-50 text-blue-600 flex items-center justify-center shrink-0">
                            <i data-lucide="file-text" class="w-4 h-4"></i>
                          </div>
                          <div>
                            <h4 class="text-xs font-bold text-slate-900 leading-tight">${doc.title}</h4>
                            <p class="text-[9px] text-slate-500 mt-0.5">Autor: ${doc.author_name} • ${new Date(doc.uploaded_at).toLocaleDateString("pt-BR")}</p>
                          </div>
                        </div>
                        <button onclick="document.getElementById('${this.id}').component.viewDocument('${doc.path}')" class="bg-slate-50 hover:bg-blue-600 text-slate-600 hover:text-white px-3 py-1.5 rounded-lg text-[10px] font-bold transition flex items-center gap-1">
                          <i data-lucide="eye" class="w-3 h-3"></i> Ler
                        </button>
                      </div>
                      <p class="text-[11px] text-slate-600 leading-normal line-clamp-2">${doc.description}</p>
                      <div class="flex flex-wrap gap-1.5 items-center">
                        ${doc.tags.map(t => `<span class="bg-blue-50 text-blue-600 px-2 py-0.5 rounded-full text-[9px] font-bold">${t}</span>`).join("")}
                      </div>
                    </div>
                  `).join("")}
                </div>
              </section>

              <!-- SEÇÃO DIREITA: PAINÉIS DINÂMICOS -->
              <section class="flex-1 flex flex-col h-full min-h-0">

                <!-- ABA DASHBOARD: CHAT DE IA -->
                <div class="flex-1 flex flex-col bg-white rounded-2xl shadow-sm border border-slate-100 overflow-hidden h-full min-h-0 ${isDashboard ? '' : 'hidden'}">
                  <!-- Chat Header -->
                  <div class="bg-slate-900/5 px-6 py-4 border-b border-slate-100 flex justify-between items-center shrink-0">
                    <div class="flex items-center gap-3">
                      <div class="w-10 h-10 rounded-xl bg-indigo-50 text-indigo-600 flex items-center justify-center font-bold">
                        <i data-lucide="sparkles" class="w-5 h-5"></i>
                      </div>
                      <div>
                        <h3 class="text-xs font-bold text-slate-900">Assistente IA de Engenharia</h3>
                        <p class="text-[9px] text-slate-500">RAG ativo sobre documentos técnicos</p>
                      </div>
                    </div>
                    <button onclick="const el = document.getElementById('${this.id}').component; el.next({ chatMessages: [] }); el.clearChat();" class="text-xs text-slate-500 hover:text-red-500 flex items-center gap-1 transition font-semibold">
                      <i data-lucide="trash-2" class="w-3.5 h-3.5"></i> Limpar Chat
                    </button>
                  </div>

                  <!-- Chat Messages -->
                  <div id="chat-messages-box" class="flex-1 overflow-y-auto custom-scrollbar p-6 space-y-4 pr-3 min-h-0">
                    ${s.chatMessages.map(msg => {
                      const isAi = msg.sender === "ai";
                      return `
                        <div class="flex gap-3 ${isAi ? '' : 'flex-row-reverse'}">
                          <div class="w-8 h-8 rounded-lg flex items-center justify-center text-white shrink-0 shadow-md ${isAi ? 'bg-indigo-600' : 'bg-blue-500'}">
                            <i data-lucide="${isAi ? 'bot' : 'user'}" class="w-4 h-4"></i>
                          </div>
                          <div class="rounded-2xl p-4 max-w-[85%] text-xs leading-relaxed shadow-sm border ${isAi ? 'bg-slate-50 rounded-tl-none border-slate-100 text-slate-700' : 'bg-blue-600 text-white rounded-tr-none border-blue-500'}">
                            <p class="font-bold text-[9px] uppercase tracking-wider mb-1 ${isAi ? 'text-indigo-900' : 'text-blue-100'}">${msg.name}</p>
                            <p class="whitespace-pre-line">${msg.text}</p>
                            ${msg.sources && msg.sources.length > 0 ? `
                              <div class="mt-3 pt-2.5 border-t border-slate-100 flex flex-col gap-1.5">
                                <p class="text-[9px] font-bold text-indigo-950 tracking-wider flex items-center gap-1"><i data-lucide="book-marked" class="w-3 h-3"></i> REFERÊNCIAS DO DOCUMENTO:</p>
                                <div class="flex flex-wrap gap-2">
                                  ${msg.sources.map(src => `
                                    <button onclick="document.getElementById('${this.id}').component.viewDocument('${src.path}')" class="bg-white hover:bg-indigo-50 text-indigo-600 border border-slate-200 px-3 py-1 rounded-lg text-[9px] font-bold flex items-center gap-1 transition">
                                      <i data-lucide="file-text" class="w-3 h-3"></i> ${src.title}
                                    </button>
                                  `).join("")}
                                </div>
                              </div>
                            ` : ""}
                          </div>
                        </div>
                      `;
                    }).join("")}

                    <!-- Indicador de Digitando -->
                    <div class="flex gap-3 ${s.isTyping ? '' : 'hidden'}">
                      <div class="w-8 h-8 rounded-lg bg-indigo-600 flex items-center justify-center text-white shrink-0 shadow-md">
                        <i data-lucide="bot" class="w-4 h-4"></i>
                      </div>
                      <div class="bg-slate-50 rounded-2xl rounded-tl-none px-4 py-3 border border-slate-100 flex items-center gap-1 shadow-sm">
                        <span class="w-1.5 h-1.5 rounded-full bg-indigo-400 animate-bounce"></span>
                        <span class="w-1.5 h-1.5 rounded-full bg-indigo-500 animate-bounce [animation-delay:0.2s]"></span>
                        <span class="w-1.5 h-1.5 rounded-full bg-indigo-600 animate-bounce [animation-delay:0.4s]"></span>
                      </div>
                    </div>
                  </div>

                  <!-- Chat Form -->
                  <form id="chat-submit-form" onsubmit="event.preventDefault(); const input = this.elements.namedItem('question'); document.getElementById('${this.id}').component.submitChat(input ? input.value : '')" class="p-4 border-t border-slate-100 flex gap-3 shrink-0 bg-slate-50/50">
                    <input id="chat-input-text" name="question" type="text" autocomplete="off" placeholder="Faça uma pergunta técnica sobre as especificações..." value="${s.chatInputText}" oninput="document.getElementById('${this.id}').component.updateChatInput(this.value)" class="flex-1 px-4 py-3 rounded-xl border border-slate-200 focus:outline-none focus:ring-2 focus:ring-blue-500 text-xs text-slate-700 bg-white">
                    <button type="submit" class="bg-blue-600 hover:bg-blue-700 text-white px-5 rounded-xl transition duration-200 shadow-md flex items-center justify-center gap-1 text-xs font-semibold">
                      Enviar <i data-lucide="send" class="w-3.5 h-3.5"></i>
                    </button>
                  </form>
                </div>

                <!-- ABA ÁREAS FTP -->
                <div class="flex-1 flex flex-col gap-6 h-full min-h-0 ${isFtp ? '' : 'hidden'}">
                  <!-- Pedidos Pendentes -->
                  <div class="bg-white rounded-2xl p-5 shadow-sm border border-slate-100 flex flex-col gap-3 shrink-0">
                    <h3 class="text-xs font-bold text-slate-900 flex items-center gap-2">
                      <i data-lucide="bell" class="w-4 h-4 text-orange-500 animate-bounce"></i> Pedidos de Permissão de Upload (Sua Pasta)
                    </h3>
                    <div class="space-y-2 max-h-48 overflow-y-auto custom-scrollbar">
                      ${myPendingPermissions.length === 0 ? `
                        <p class="text-xs text-slate-500 text-center py-4 bg-slate-50 rounded-xl border border-dashed border-slate-200 font-medium">Nenhum pedido pendente para liberação.</p>
                      ` : myPendingPermissions.map(req => `
                        <div class="bg-amber-50/50 p-4 rounded-xl border border-amber-100 flex items-center justify-between">
                          <div>
                            <p class="text-xs font-bold text-slate-900">${req.requester_name}</p>
                            <p class="text-[9px] text-slate-500 font-medium">${req.requester_role} (${req.requester_sector}) quer escrever na sua pasta</p>
                          </div>
                          <div class="flex gap-1.5">
                            <button onclick="document.getElementById('${this.id}').component.respondPermission(${req.id}, 'approved')" class="bg-emerald-600 hover:bg-emerald-700 text-white text-[10px] font-bold px-3 py-1.5 rounded-lg flex items-center gap-0.5 transition shadow-sm">
                              <i data-lucide="check" class="w-3 h-3"></i> Permitir
                            </button>
                            <button onclick="document.getElementById('${this.id}').component.respondPermission(${req.id}, 'rejected')" class="bg-slate-200 hover:bg-slate-300 text-slate-700 text-[10px] font-bold px-3 py-1.5 rounded-lg flex items-center gap-0.5 transition">
                              <i data-lucide="x" class="w-3 h-3"></i> Negar
                            </button>
                          </div>
                        </div>
                      `).join("")}
                    </div>
                  </div>

                  <!-- Explorador FTP -->
                  <div class="bg-white rounded-2xl p-6 shadow-sm border border-slate-100 flex-1 flex flex-col min-h-0">
                    <div class="flex justify-between items-center mb-4 shrink-0">
                      <div>
                        <h3 class="text-xs font-bold text-slate-900 flex items-center gap-2">
                          <i data-lucide="folder-git-2" class="w-4 h-4 text-blue-600"></i> Áreas FTP e Diretórios Locais
                        </h3>
                        <p class="text-[9px] text-slate-500 font-medium mt-0.5">Sincronize arquivos pelo cliente FTP em <span class="font-mono bg-slate-100 px-1 py-0.5 rounded text-blue-600 text-[10px]">ftp://&lt;ip-servidor&gt;:2121</span></p>
                      </div>

                      <div class="flex items-center gap-2">
                        <input id="web-file-input" type="file" class="hidden" onchange="const f = this.files[0]; if(f) document.getElementById('${this.id}').component.uploadFile(f, '${myFolderName}')">
                        <button onclick="document.getElementById('web-file-input').click()" class="bg-emerald-600 hover:bg-emerald-700 text-white font-bold text-xs px-4 py-2 rounded-xl transition duration-200 flex items-center gap-1.5 shadow-md shadow-emerald-500/10 ${s.isUploading ? 'opacity-50 cursor-not-allowed' : ''}" ${s.isUploading ? 'disabled' : ''}>
                          <i data-lucide="upload-cloud" class="w-4 h-4"></i> ${s.isUploading ? 'Enviando...' : 'Enviar Manual (Sua Pasta)'}
                        </button>
                      </div>
                    </div>

                    <!-- Pastas de Usuários Grid -->
                    <div class="flex-1 grid grid-cols-2 gap-4 overflow-y-auto custom-scrollbar pr-2 min-h-0">
                      ${s.usersList.map(u => {
                        const folderName = u.name.toLowerCase().replace(/[^a-z0-9]+/g, "");
                        const isOwnFolder = myFolderName === folderName;

                        const hasPermission = s.allPermissions.some(p => p.requester_mac === s.user.mac && p.target_username === folderName && p.status === "approved");
                        const isPending = s.allPermissions.some(p => p.requester_mac === s.user.mac && p.target_username === folderName && p.status === "pending");

                        let badgeHtml = "";
                        let actionHtml = "";

                        if (isOwnFolder) {
                          badgeHtml = `<span class="bg-emerald-50 text-emerald-600 text-[9px] font-bold px-2 py-0.5 rounded-full border border-emerald-100">Sua Pasta</span>`;
                          actionHtml = `
                            <button onclick="document.getElementById('web-file-input').click()" class="bg-emerald-600 hover:bg-emerald-700 text-white font-bold text-[10px] px-3.5 py-2 rounded-lg flex items-center gap-1 transition shrink-0">
                              <i data-lucide="upload" class="w-3 h-3"></i> Upload
                            </button>
                          `;
                        } else if (hasPermission) {
                          badgeHtml = `<span class="bg-blue-50 text-blue-600 text-[9px] font-bold px-2 py-0.5 rounded-full border border-blue-100">Permissão Concedida</span>`;
                          actionHtml = `
                            <input id="cross-file-input-${folderName}" type="file" class="hidden" onchange="const f = this.files[0]; if(f) document.getElementById('${this.id}').component.uploadFile(f, '${folderName}')">
                            <button onclick="document.getElementById('cross-file-input-${folderName}').click()" class="bg-blue-600 hover:bg-blue-700 text-white font-bold text-[10px] px-3.5 py-2 rounded-lg flex items-center gap-1 transition shrink-0">
                              <i data-lucide="upload" class="w-3 h-3"></i> Upload
                            </button>
                          `;
                        } else if (isPending) {
                          badgeHtml = `<span class="bg-amber-50 text-amber-600 text-[9px] font-bold px-2 py-0.5 rounded-full border border-amber-100 font-medium">Aguardando</span>`;
                          actionHtml = `
                            <button disabled class="bg-slate-100 text-slate-400 font-bold text-[10px] px-3.5 py-2 rounded-lg flex items-center gap-1 cursor-not-allowed shrink-0">
                              <i data-lucide="clock" class="w-3 h-3"></i> Solicitado
                            </button>
                          `;
                        } else {
                          badgeHtml = `<span class="bg-slate-100 text-slate-500 text-[9px] font-bold px-2 py-0.5 rounded-full border border-slate-200">Restrita</span>`;
                          actionHtml = `
                            <button onclick="document.getElementById('${this.id}').component.requestPermission('${folderName}')" class="bg-slate-800 hover:bg-slate-950 text-white font-bold text-[10px] px-3.5 py-2 rounded-lg flex items-center gap-1 transition shrink-0">
                              <i data-lucide="lock" class="w-3 h-3"></i> Pedir Escrita
                            </button>
                          `;
                        }

                        return `
                          <div class="bg-slate-50 rounded-xl p-5 border border-slate-200/70 flex flex-col justify-between gap-4 h-36">
                            <div class="flex justify-between items-start">
                              <div class="flex items-center gap-2">
                                <div class="w-9 h-9 rounded-lg bg-slate-200 text-slate-600 flex items-center justify-center shrink-0">
                                  <i data-lucide="folder" class="w-5 h-5"></i>
                                </div>
                                <div class="text-left leading-tight">
                                  <h4 class="text-xs font-bold text-slate-900">uploads_raw/${folderName}/</h4>
                                  <p class="text-[9px] text-slate-400 font-medium mt-0.5">Dono: ${u.name} (${u.role})</p>
                                </div>
                              </div>
                              ${badgeHtml}
                            </div>
                            <div class="flex justify-between items-center border-t border-slate-200/50 pt-3 shrink-0">
                              <span class="text-[9px] text-slate-400 font-mono">FTP: ftp://ip:2121/${folderName}/</span>
                              ${actionHtml}
                            </div>
                          </div>
                        `;
                      }).join("")}
                    </div>
                  </div>
                </div>

                <!-- ABA ATIVIDADES / TAREFAS -->
                <div class="flex-1 flex flex-col gap-6 h-full min-h-0 ${isTasks ? '' : 'hidden'}">
                  <!-- Criar Nova Tarefa -->
                  <div class="bg-white rounded-2xl p-5 shadow-sm border border-slate-100 flex flex-col gap-4 shrink-0">
                    <h3 class="text-xs font-bold text-slate-900 flex items-center gap-2">
                      <i data-lucide="plus-circle" class="w-4 h-4 text-blue-600"></i> Delegar Nova Atividade Técnica
                    </h3>
                    <div class="grid grid-cols-3 gap-3">
                      <input id="task-title-input" type="text" placeholder="Título da Atividade" value="${s.taskTitle}" onblur="document.getElementById('${this.id}').component.updateTaskField('taskTitle', this.value)" class="px-4 py-2.5 bg-slate-50 border border-slate-200 rounded-xl text-xs focus:outline-none focus:ring-2 focus:ring-blue-500 text-slate-700">
                      <select id="task-assigned-select" onblur="document.getElementById('${this.id}').component.updateTaskField('taskAssignedMac', this.value)" class="px-4 py-2.5 bg-slate-50 border border-slate-200 rounded-xl text-xs focus:outline-none focus:ring-2 focus:ring-blue-500 text-slate-600 bg-white">
                        <option value="">Selecione o Responsável...</option>
                        ${s.usersList.map(u => `<option value="${u.mac}" ${s.taskAssignedMac === u.mac ? 'selected' : ''}>${u.name} (${u.role})</option>`).join("")}
                      </select>
                      <button onclick="document.getElementById('${this.id}').component.createTask()" class="bg-blue-600 hover:bg-blue-700 text-white font-semibold text-xs px-4 py-2 rounded-xl transition duration-200 flex items-center justify-center gap-1 shadow-md shadow-blue-500/10 shrink-0">
                        <i data-lucide="plus" class="w-4 h-4"></i> Criar Atividade
                      </button>
                    </div>
                    <textarea id="task-desc-input" placeholder="Descreva os procedimentos técnicos, detalhes de medições e requisitos de segurança..." onblur="document.getElementById('${this.id}').component.updateTaskField('taskDesc', this.value)" class="w-full px-4 py-2.5 bg-slate-50 border border-slate-200 rounded-xl text-xs focus:outline-none focus:ring-2 focus:ring-blue-500 text-slate-700 h-16 resize-none">${s.taskDesc}</textarea>
                  </div>

                  <!-- Quadro de Atividades -->
                  <div class="bg-white rounded-2xl p-6 shadow-sm border border-slate-100 flex-1 flex flex-col min-h-0">
                    <h3 class="text-xs font-bold text-slate-900 flex items-center gap-2 mb-4 shrink-0">
                      <i data-lucide="clipboard-list" class="w-4 h-4 text-indigo-500"></i> Quadro de Atividades da Equipe
                    </h3>
                    <div class="flex-1 overflow-y-auto custom-scrollbar space-y-3 pr-2 min-h-0">
                      ${s.tasks.length === 0 ? `
                        <p class="text-xs text-slate-500 text-center py-8 font-medium">Nenhuma atividade registrada ou delegada.</p>
                      ` : s.tasks.map(t => {
                        let statusColor = "";
                        let statusText = "";
                        let actionButtons = "";

                        if (t.status === "pending") {
                          statusColor = "bg-amber-100 text-amber-800 border-amber-200";
                          statusText = "Pendente";
                          actionButtons = `
                            <button onclick="document.getElementById('${this.id}').component.updateTaskStatus(${t.id}, 'in_progress')" class="bg-blue-600 hover:bg-blue-700 text-white font-bold text-[10px] px-3 py-1.5 rounded-lg flex items-center gap-0.5 transition shadow-sm shrink-0">
                              <i data-lucide="play" class="w-3 h-3"></i> Iniciar
                            </button>
                          `;
                        } else if (t.status === "in_progress") {
                          statusColor = "bg-blue-100 text-blue-800 border-blue-200 animate-pulse";
                          statusText = "Em Progresso";
                          actionButtons = `
                            <button onclick="document.getElementById('${this.id}').component.updateTaskStatus(${t.id}, 'completed')" class="bg-emerald-600 hover:bg-emerald-700 text-white font-bold text-[10px] px-3 py-1.5 rounded-lg flex items-center gap-0.5 transition shadow-sm shrink-0">
                              <i data-lucide="check-circle-2" class="w-3 h-3"></i> Concluir
                            </button>
                          `;
                        } else if (t.status === "completed") {
                          statusColor = "bg-emerald-100 text-emerald-800 border-emerald-200";
                          statusText = "Concluído";
                          actionButtons = `
                            <span class="text-slate-400 font-bold text-[10px] flex items-center gap-0.5"><i data-lucide="check" class="w-3 h-3"></i> Resolvida</span>
                          `;
                        }

                        return `
                          <div class="bg-slate-50 rounded-xl p-5 border border-slate-200/80 flex justify-between items-center gap-4">
                            <div class="flex-1 text-left">
                              <div class="flex items-center gap-2 mb-1.5">
                                <span class="px-2 py-0.5 rounded-full text-[9px] font-bold border ${statusColor}">${statusText}</span>
                                <h4 class="text-xs font-bold text-slate-900">${t.title}</h4>
                              </div>
                              <p class="text-[11px] text-slate-600 leading-normal mb-1.5">${t.description}</p>
                              <p class="text-[9px] text-slate-400 font-medium">Delegado a: <span class="font-bold text-slate-600">${t.assigned_to_name}</span> (${t.assigned_to_role})</p>
                            </div>
                            <div class="shrink-0">
                              ${actionButtons}
                            </div>
                          </div>
                        `;
                      }).join("")}
                    </div>
                  </div>
                </div>

              </section>

            </main>

            <!-- MODAL DE LEITURA DE DOCUMENTOS -->
            <div class="fixed inset-0 bg-slate-900/80 backdrop-blur-sm z-50 flex items-center justify-center p-4 ${s.selectedDocContent ? '' : 'hidden'}" onclick="if(event.target === this) document.getElementById('${this.id}').component.closeDocument()">
              <div class="bg-white rounded-2xl shadow-2xl max-w-4xl w-full h-[85vh] flex flex-col overflow-hidden border border-slate-100">
                <!-- Header -->
                <div class="px-6 py-4 border-b border-slate-100 bg-slate-50 flex items-center justify-between shrink-0">
                  <div class="flex items-center gap-2">
                    <i data-lucide="file-text" class="w-5 h-5 text-blue-600"></i>
                    <div class="text-left">
                      <h3 class="text-xs font-bold text-slate-900">${s.selectedDocTitle || '-'}</h3>
                      <p class="text-[9px] text-slate-500 font-medium">${s.selectedDocMeta || '-'}</p>
                    </div>
                  </div>
                  <button onclick="document.getElementById('${this.id}').component.closeDocument()" class="p-2 hover:bg-slate-200 rounded-lg text-slate-500 hover:text-slate-800 transition">
                    <i data-lucide="x" class="w-5 h-5"></i>
                  </button>
                </div>
                <!-- Markdown Content -->
                <div class="flex-1 p-8 overflow-y-auto custom-scrollbar prose prose-slate max-w-none text-left bg-white">
                  ${s.selectedDocContent ? renderMarkdown(s.selectedDocContent) : ""}
                </div>
              </div>
            </div>

          </div>
        `,
      }).content.firstElementChild)),
    );
  }
}

// --- INICIALIZAÇÃO DO APP - EXPLICITA, COMPILADA E SEM BINDERS/HELPERS ---

const appCtx = {};
const appIterator = AppGenerator.call(appCtx, { id: "app-root" });

// Bind explícito dos métodos iteradores diretamente no contexto conforme especificação pura
const rawGeneratorNext = appIterator.next.bind(appIterator);
let generatorRunning = false;
let queuedGeneratorPatches = [];

appCtx.next = patch => {
  if (generatorRunning) {
    if (patch && typeof patch === "object") {
      queuedGeneratorPatches.push(patch);
    }
    return { done: false, value: appCtx.element || null };
  }

  generatorRunning = true;
  let result;

  try {
    result = rawGeneratorNext(patch);
  } finally {
    generatorRunning = false;
  }

  if (queuedGeneratorPatches.length > 0) {
    const mergedPatch = Object.assign(
      {},
      ...queuedGeneratorPatches.splice(0)
    );
    queueMicrotask(() => appCtx.next(mergedPatch));
  }

  return result;
};

appCtx.return = appIterator.return.bind(appIterator);
appCtx.throw = appIterator.throw.bind(appIterator);

// Adiciona limpa chat como método nativo visível
appCtx.clearChat = () => {
  appCtx.next({
    chatMessages: [
      {
        id: "welcome",
        sender: "ai",
        name: "IA Assistente",
        text: "Central de Engenharia Resetada.\n\nChat limpo. Faça uma nova pergunta sobre nossos projetos e documentos técnicos!"
      }
    ]
  });
};

// Executa primeiro avanço para pegar o HTMLElement inicial e acoplar
const initialElement = appCtx.next().value;
document.body.prepend(initialElement);
