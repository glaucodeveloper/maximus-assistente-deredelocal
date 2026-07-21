import {Engine, loadLiteRtLm} from '@litert-lm/core';
import {component, escapeHtml, safeId} from './component.js';
import {clearGithubToken, loadGithubToken, saveGithubToken} from './device-store.js';
import {GitHubRepository, loadAppConfig} from './github.js';
import {loginUser, registerUser} from './auth.js';
import {
  listOkfDocuments,
  listUserFiles,
  readOkfDocument,
  uploadUserFile,
} from './knowledge-store.js';
import {deleteModel, downloadModel, formatBytes, getModelFile, hasModel, MODEL} from './model-store.js';
import {buildRlmSystemPrompt, runRlm} from './rlm.js';
import {isStandalone, registerServiceWorker, warmInstalledApp} from './pwa.js';

function renderMessages(messages) {
  return messages.map(message => `
    <article class="message ${message.role}">
      <div class="message-label">${message.role === 'user' ? 'Você' : escapeHtml(message.name || 'Assistente')}</div>
      <div class="message-content">${escapeHtml(message.content)}</div>
    </article>
  `).join('');
}

function renderFileList(files, componentId) {
  if (!files.length) return '<p class="empty-state">Nenhum arquivo enviado.</p>';
  return files.map(file => `
    <article class="resource-card">
      <div class="resource-icon">${file.textReadable ? 'TXT' : 'BIN'}</div>
      <div class="resource-copy">
        <strong>${escapeHtml(file.name)}</strong>
        <span>${formatBytes(file.size)} · ${file.textReadable ? 'legível pelo RLM' : 'somente armazenado'}</span>
      </div>
      ${file.textReadable ? `<button class="icon-button" title="Usar no chat" onclick="document.getElementById('${componentId}').component.useFile('${encodeURIComponent(file.id)}')">→</button>` : ''}
    </article>
  `).join('');
}

function renderOkfList(documents, componentId) {
  if (!documents.length) return '<p class="empty-state">Nenhum documento OKF encontrado.</p>';
  return documents.slice(0, 80).map(document => `
    <article class="resource-card">
      <div class="resource-icon okf">OKF</div>
      <div class="resource-copy">
        <strong>${escapeHtml(document.name)}</strong>
        <span>${document.scope === 'base' ? 'base compartilhada' : 'usuário'}</span>
      </div>
      <button class="icon-button" title="Usar no chat" onclick="document.getElementById('${componentId}').component.useOkf('${encodeURIComponent(document.path)}')">→</button>
    </article>
  `).join('');
}

function* AppComponent({id}) {
  this.id = safeId(id, 'okf-chat-app');
  this.element = null;
  this.config = null;
  this.repository = null;
  this.token = '';
  this.user = null;
  this.engine = null;
  this.conversation = null;
  this.generating = false;
  this.downloadController = null;
  this.installPrompt = null;
  this.approvalResolver = null;

  this.state = {
    phase: 'boot',
    status: 'Inicializando…',
    error: '',
    busy: false,
    authMode: 'login',
    githubUser: null,
    repositoryInfo: null,
    user: null,
    files: [],
    okfDocuments: [],
    sidebarTab: 'files',
    messages: [],
    modelReady: false,
    downloaded: 0,
    total: MODEL.approximateBytes,
    progress: 0,
    generating: false,
    pendingApproval: null,
    installAvailable: false,
    installed: isStandalone(),
  };

  this.patch = patch => this.next(patch);

  this.bootstrap = async () => {
    try {
      await registerServiceWorker();
      this.config = await loadAppConfig();
      const token = await loadGithubToken();
      if (!token) {
        this.patch({phase: 'token', status: 'Informe a chave de acesso ao repositório.', error: ''});
        return;
      }
      await this.connectWithToken(token, false);
    } catch (error) {
      this.patch({phase: 'token', status: 'Configuração necessária.', error: error.message});
    }
  };

  this.connectWithToken = async (token, persist) => {
    if (this.state.busy) return;
    this.patch({busy: true, error: '', status: 'Validando chave no GitHub…'});
    try {
      if (!this.config) this.config = await loadAppConfig();
      const repository = new GitHubRepository({token, config: this.config});
      const identity = await repository.validate();
      await saveGithubToken(token, persist);
      this.token = token;
      this.repository = repository;
      this.patch({
        busy: false,
        phase: 'auth',
        status: 'Conexão pronta. Entre ou crie seu cadastro.',
        githubUser: identity.user,
        repositoryInfo: identity.repository,
      });
    } catch (error) {
      this.patch({busy: false, phase: 'token', status: 'Não foi possível conectar.', error: error.message});
    }
  };

  this.submitToken = async () => {
    const token = document.querySelector('#github-token')?.value.trim() || '';
    const remember = document.querySelector('#remember-token')?.checked === true;
    if (!token) {
      this.patch({error: 'Informe um fine-grained personal access token.', status: 'Chave ausente.'});
      return;
    }
    await this.connectWithToken(token, remember);
  };

  this.setAuthMode = mode => this.patch({authMode: mode === 'register' ? 'register' : 'login', error: ''});

  this.submitAuth = async () => {
    if (this.state.busy || !this.repository) return;
    const username = document.querySelector('#account-username')?.value || '';
    const password = document.querySelector('#account-password')?.value || '';
    const displayName = document.querySelector('#account-display-name')?.value || '';
    this.patch({busy: true, error: '', status: this.state.authMode === 'register' ? 'Criando cadastro…' : 'Entrando…'});

    try {
      const user = this.state.authMode === 'register'
        ? await registerUser(this.repository, this.config, {username, displayName, password})
        : await loginUser(this.repository, this.config, {username, password});
      this.user = user;
      await this.afterAuthentication(user);
    } catch (error) {
      this.patch({busy: false, status: 'Não foi possível autenticar.', error: error.message});
    }
  };

  this.afterAuthentication = async user => {
    const [files, okfDocuments, modelReady] = await Promise.all([
      listUserFiles(this.repository, this.config, user),
      listOkfDocuments(this.repository, this.config, user),
      hasModel(),
    ]);
    this.patch({
      busy: false,
      user,
      files,
      okfDocuments,
      modelReady,
      phase: modelReady ? 'loading-model' : 'model',
      status: modelReady ? 'Carregando o modelo local…' : 'Baixe o modelo local para iniciar o chat.',
    });
    if (modelReady) await this.loadModel();
  };

  this.startModelDownload = async () => {
    if (this.state.busy || this.state.modelReady) return;
    this.downloadController = new AbortController();
    this.patch({busy: true, error: '', status: `Baixando ${MODEL.displayName}…`, progress: 0});
    try {
      let lastUpdate = 0;
      await downloadModel({
        signal: this.downloadController.signal,
        onProgress: ({received, total, ratio}) => {
          const now = performance.now();
          if (ratio < 1 && now - lastUpdate < 250) return;
          lastUpdate = now;
          this.patch({downloaded: received, total, progress: Math.round(ratio * 100)});
        },
      });
      await warmInstalledApp();
      this.patch({busy: false, modelReady: true, phase: 'loading-model', progress: 100, status: 'Modelo baixado. Inicializando…'});
      await this.loadModel();
    } catch (error) {
      const cancelled = error?.name === 'AbortError';
      this.patch({busy: false, status: cancelled ? 'Download cancelado.' : 'Falha no download.', error: cancelled ? '' : error.message});
    } finally {
      this.downloadController = null;
    }
  };

  this.cancelModelDownload = () => this.downloadController?.abort();

  this.loadModel = async () => {
    try {
      this.patch({phase: 'loading-model', busy: true, error: '', status: 'Carregando Gemma 4 no WebGPU…'});
      if (!navigator.gpu) {
        throw new Error('WebGPU não está disponível. Use Chromium atualizado com aceleração de hardware ativa.');
      }
      if (typeof WebAssembly.Suspending !== 'function' || typeof WebAssembly.promising !== 'function') {
        throw new Error('Este navegador não oferece JSPI para WebAssembly. Use uma versão recente do Chromium no Manjaro.');
      }
      await loadLiteRtLm('./wasm/');
      const modelFile = await getModelFile();
      await this.disposeModel();
      this.engine = await Engine.create({
        model: modelFile,
        mainExecutorSettings: {maxNumTokens: this.config.model.maxNumTokens},
      });
      this.conversation = await this.engine.createConversation({
        preface: {messages: [{role: 'system', content: buildRlmSystemPrompt(this.config)}]},
      });
      this.patch({
        phase: 'ready',
        busy: false,
        status: `${MODEL.displayName} pronto.`,
        messages: [{role: 'assistant', name: this.config.assistant.name, content: this.config.assistant.welcome}],
      });
    } catch (error) {
      await this.disposeModel();
      this.patch({phase: 'model', busy: false, modelReady: false, status: 'Não foi possível carregar o modelo.', error: error.message});
    }
  };

  this.refreshResources = async () => {
    if (!this.user || !this.repository) return;
    const [files, okfDocuments] = await Promise.all([
      listUserFiles(this.repository, this.config, this.user),
      listOkfDocuments(this.repository, this.config, this.user),
    ]);
    this.patch({files, okfDocuments});
  };

  this.openUpload = () => document.querySelector('#file-upload')?.click();

  this.uploadSelected = async () => {
    const input = document.querySelector('#file-upload');
    const file = input?.files?.[0];
    if (!file || this.state.busy) return;
    this.patch({busy: true, error: '', status: `Enviando ${file.name} ao namespace do usuário…`});
    try {
      const metadata = await uploadUserFile(this.repository, this.config, this.user, file);
      if (input) input.value = '';
      await this.refreshResources();
      this.patch({busy: false, sidebarTab: 'files', status: `${metadata.name} enviado.`});
    } catch (error) {
      this.patch({busy: false, status: 'Falha no upload.', error: error.message});
    }
  };

  this.useFile = encodedId => {
    const fileId = decodeURIComponent(encodedId);
    const file = this.state.files.find(item => item.id === fileId);
    const input = document.querySelector('#prompt-input');
    if (input && file) {
      input.value = `Leia o arquivo “${file.name}” e responda: `;
      input.focus();
    }
  };

  this.useOkf = encodedPath => {
    const path = decodeURIComponent(encodedPath);
    const input = document.querySelector('#prompt-input');
    if (input) {
      input.value = `Consulte o documento OKF ${path} e responda: `;
      input.focus();
    }
  };

  this.previewOkf = async encodedPath => {
    const path = decodeURIComponent(encodedPath);
    try {
      const document = await readOkfDocument(this.repository, this.config, this.user, path, {maxChars: 6000});
      this.patch({messages: [...this.state.messages, {role: 'assistant', name: 'OKF', content: document.content}]});
    } catch (error) {
      this.patch({error: error.message});
    }
  };

  this.requestApproval = approval => new Promise(resolve => {
    this.approvalResolver = resolve;
    this.patch({pendingApproval: approval, status: 'Aguardando aprovação para gravar no repositório…'});
  });

  this.resolveApproval = approved => {
    const resolver = this.approvalResolver;
    this.approvalResolver = null;
    this.patch({pendingApproval: null, status: approved ? 'Gravação aprovada.' : 'Gravação recusada.'});
    resolver?.(Boolean(approved));
  };

  this.send = async () => {
    if (!this.conversation || this.generating || this.state.pendingApproval) return;
    const input = document.querySelector('#prompt-input');
    const prompt = input?.value.trim() || '';
    if (!prompt) return;
    if (input) input.value = '';

    this.generating = true;
    const messages = [...this.state.messages, {role: 'user', content: prompt}];
    this.patch({messages, generating: true, error: '', status: 'Iniciando RLM…'});

    try {
      const answer = await runRlm({
        conversation: this.conversation,
        repository: this.repository,
        config: this.config,
        user: this.user,
        prompt,
        onStatus: status => this.patch({status}),
        requestApproval: approval => this.requestApproval(approval),
      });
      await this.refreshResources();
      this.patch({
        messages: [...this.state.messages, {role: 'assistant', name: this.config.assistant.name, content: answer || 'Sem resposta.'}],
        generating: false,
        status: 'Pronto.',
      });
    } catch (error) {
      const cancelled = error?.name === 'AbortError';
      this.patch({generating: false, status: cancelled ? 'Geração cancelada.' : 'Falha no RLM.', error: cancelled ? '' : error.message});
    } finally {
      this.generating = false;
    }
  };

  this.cancel = () => {
    this.conversation?.cancel();
    this.generating = false;
    this.patch({generating: false, status: 'Cancelando…'});
  };

  this.setSidebarTab = tab => this.patch({sidebarTab: tab === 'okf' ? 'okf' : 'files'});

  this.logout = async () => {
    await this.disposeModel();
    this.user = null;
    this.patch({phase: 'auth', user: null, messages: [], files: [], okfDocuments: [], status: 'Sessão encerrada.', error: ''});
  };

  this.disconnect = async () => {
    await this.disposeModel();
    await clearGithubToken();
    this.token = '';
    this.repository = null;
    this.user = null;
    this.patch({phase: 'token', githubUser: null, repositoryInfo: null, user: null, status: 'Informe uma nova chave.', error: ''});
  };

  this.removeModel = async () => {
    await this.disposeModel();
    await deleteModel();
    this.patch({phase: 'model', modelReady: false, progress: 0, status: 'Modelo removido deste dispositivo.'});
  };

  this.captureInstallPrompt = event => {
    event.preventDefault();
    this.installPrompt = event;
    this.patch({installAvailable: true});
  };

  this.install = async () => {
    if (!this.installPrompt) {
      this.patch({status: 'Use o menu do Chromium e escolha “Instalar OKF Chat”.'});
      return;
    }
    await this.installPrompt.prompt();
    const result = await this.installPrompt.userChoice;
    this.installPrompt = null;
    this.patch({installAvailable: false, installed: result.outcome === 'accepted', status: result.outcome === 'accepted' ? 'PWA instalado.' : 'Instalação cancelada.'});
  };

  this.disposeModel = async () => {
    this.conversation?.cancel();
    this.conversation = null;
    if (this.engine) await this.engine.delete().catch(() => {});
    this.engine = null;
  };

  window.addEventListener('beforeinstallprompt', this.captureInstallPrompt);
  window.addEventListener('appinstalled', () => this.patch({installed: true, installAvailable: false}));
  window.addEventListener('pagehide', () => void this.disposeModel(), {once: true});

  while (true) {
    Object.assign(
      this.state,
      yield (this.element = ((element) => {
        element.id = this.id;
        element.component = this;
        if (this.element?.isConnected) this.element.replaceWith(element);
        queueMicrotask(() => {
          const messages = element.querySelector('.messages');
          if (messages) messages.scrollTop = messages.scrollHeight;
        });
        return element;
      })(Object.assign(document.createElement('template'), {
        innerHTML: /* html */ `
          <section class="app-frame phase-${this.state.phase}">
            ${this.state.phase === 'boot' ? `
              <main class="gate"><div class="loader"></div><p>${escapeHtml(this.state.status)}</p></main>
            ` : ''}

            ${this.state.phase === 'token' ? `
              <main class="gate">
                <section class="gate-card token-card">
                  <div class="brand-mark">OKF</div>
                  <p class="eyebrow">Gemma 4 · LiteRT-LM · GitHub</p>
                  <h1>Chave de acesso</h1>
                  <p class="lead">Informe o token que dá acesso ao repositório privado configurado nesta instalação.</p>
                  <label class="field"><span>GitHub token</span><input id="github-token" type="password" autocomplete="off" placeholder="github_pat_…" ${this.state.busy ? 'disabled' : ''}></label>
                  <label class="check"><input id="remember-token" type="checkbox" checked><span>Salvar criptografado neste dispositivo</span></label>
                  <button class="primary wide" ${this.state.busy ? 'disabled' : ''} onclick="document.getElementById('${this.id}').component.submitToken()">${this.state.busy ? 'Validando…' : 'Continuar'}</button>
                  <p class="security-copy">O token precisa de <strong>Contents: Read and write</strong>. Ele não é enviado ao modelo.</p>
                  ${this.state.error ? `<div class="inline-error">${escapeHtml(this.state.error)}</div>` : ''}
                </section>
              </main>
            ` : ''}

            ${this.state.phase === 'auth' ? `
              <main class="gate">
                <section class="gate-card auth-card">
                  <div class="auth-context">
                    <div class="brand-mark small">OKF</div>
                    <div><strong>${escapeHtml(this.state.repositoryInfo?.fullName || '')}</strong><span>conectado como ${escapeHtml(this.state.githubUser?.login || '')}</span></div>
                  </div>
                  <div class="segmented">
                    <button class="${this.state.authMode === 'login' ? 'active' : ''}" onclick="document.getElementById('${this.id}').component.setAuthMode('login')">Entrar</button>
                    <button class="${this.state.authMode === 'register' ? 'active' : ''}" onclick="document.getElementById('${this.id}').component.setAuthMode('register')">Cadastrar</button>
                  </div>
                  <h1>${this.state.authMode === 'login' ? 'Acessar seu espaço' : 'Criar seu espaço'}</h1>
                  <p class="lead">Cada cadastro usa um namespace próprio de arquivos e documentos OKF.</p>
                  ${this.state.authMode === 'register' ? `<label class="field"><span>Nome exibido</span><input id="account-display-name" autocomplete="name" maxlength="80"></label>` : ''}
                  <label class="field"><span>Usuário</span><input id="account-username" autocomplete="username" maxlength="32"></label>
                  <label class="field"><span>Senha</span><input id="account-password" type="password" autocomplete="${this.state.authMode === 'login' ? 'current-password' : 'new-password'}"></label>
                  <button class="primary wide" ${this.state.busy ? 'disabled' : ''} onclick="document.getElementById('${this.id}').component.submitAuth()">${this.state.busy ? 'Processando…' : this.state.authMode === 'login' ? 'Entrar' : 'Criar cadastro'}</button>
                  <button class="text-button" onclick="document.getElementById('${this.id}').component.disconnect()">Trocar chave do GitHub</button>
                  <p class="security-copy warning">A separação é por pastas. Quem possui acesso direto ao repositório consegue ver ou alterar todos os namespaces.</p>
                  ${this.state.error ? `<div class="inline-error">${escapeHtml(this.state.error)}</div>` : ''}
                </section>
              </main>
            ` : ''}

            ${this.state.phase === 'model' ? `
              <main class="gate">
                <section class="gate-card model-card">
                  <div class="brand-mark">G4</div>
                  <p class="eyebrow">Configuração local</p>
                  <h1>Baixar o modelo</h1>
                  <p class="lead">O Gemma 4 E2B será salvo no armazenamento privado do navegador e reutilizado pelo PWA.</p>
                  <div class="model-spec"><span>${MODEL.displayName}</span><strong>≈ ${formatBytes(MODEL.approximateBytes)}</strong></div>
                  <progress max="100" value="${this.state.progress}"></progress>
                  <p class="progress-copy">${this.state.progress ? `${this.state.progress}% · ${formatBytes(this.state.downloaded)} de ${formatBytes(this.state.total)}` : 'WebGPU obrigatório'}</p>
                  <div class="button-row">
                    <button class="primary" ${this.state.busy ? 'disabled' : ''} onclick="document.getElementById('${this.id}').component.startModelDownload()">${this.state.busy ? 'Baixando…' : 'Baixar modelo'}</button>
                    ${this.state.busy ? `<button class="secondary" onclick="document.getElementById('${this.id}').component.cancelModelDownload()">Cancelar</button>` : ''}
                    <button class="secondary" onclick="document.getElementById('${this.id}').component.logout()">Sair</button>
                  </div>
                  ${this.state.error ? `<div class="inline-error">${escapeHtml(this.state.error)}</div>` : ''}
                </section>
              </main>
            ` : ''}

            ${this.state.phase === 'loading-model' ? `
              <main class="gate"><div class="loader"></div><h2>Preparando o chat local</h2><p>${escapeHtml(this.state.status)}</p></main>
            ` : ''}

            ${this.state.phase === 'ready' ? `
              <aside class="sidebar">
                <div class="sidebar-brand"><div class="brand-mark small">OKF</div><div><strong>${escapeHtml(this.config?.assistant?.name || 'OKF Chat')}</strong><span>local + repositório</span></div></div>
                <div class="user-chip"><div class="avatar">${escapeHtml((this.state.user?.displayName || 'U').slice(0, 1).toUpperCase())}</div><div><strong>${escapeHtml(this.state.user?.displayName || '')}</strong><span>@${escapeHtml(this.state.user?.username || '')}</span></div></div>
                <button class="upload-button" ${this.state.busy ? 'disabled' : ''} onclick="document.getElementById('${this.id}').component.openUpload()">＋ Enviar arquivo</button>
                <input id="file-upload" class="sr-only" type="file" onchange="document.getElementById('${this.id}').component.uploadSelected()">
                <div class="resource-tabs">
                  <button class="${this.state.sidebarTab === 'files' ? 'active' : ''}" onclick="document.getElementById('${this.id}').component.setSidebarTab('files')">Arquivos <span>${this.state.files.length}</span></button>
                  <button class="${this.state.sidebarTab === 'okf' ? 'active' : ''}" onclick="document.getElementById('${this.id}').component.setSidebarTab('okf')">OKF <span>${this.state.okfDocuments.length}</span></button>
                </div>
                <div class="resource-list">${this.state.sidebarTab === 'files' ? renderFileList(this.state.files, this.id) : renderOkfList(this.state.okfDocuments, this.id)}</div>
                <div class="sidebar-footer">
                  <button class="text-button" onclick="document.getElementById('${this.id}').component.install()">${this.state.installed ? 'PWA instalado' : 'Instalar PWA'}</button>
                  <button class="text-button" onclick="document.getElementById('${this.id}').component.logout()">Sair do usuário</button>
                  <button class="text-button danger-text" onclick="document.getElementById('${this.id}').component.disconnect()">Remover token</button>
                </div>
              </aside>
              <main class="chat-main">
                <header class="chat-header">
                  <div><p class="eyebrow">RLM com ferramentas locais</p><h1>Chat da base OKF</h1></div>
                  <div class="runtime-pill"><span></span>${escapeHtml(this.state.status)}</div>
                </header>
                ${this.state.error ? `<div class="chat-error">${escapeHtml(this.state.error)}</div>` : ''}
                <section class="messages" aria-live="polite">${renderMessages(this.state.messages)}</section>
                <section class="composer">
                  <textarea id="prompt-input" rows="3" placeholder="Pergunte sobre a base, peça para ler um arquivo ou criar um OKF…" ${this.state.generating ? 'disabled' : ''} onkeydown="if(event.key === 'Enter' && !event.shiftKey){event.preventDefault();document.getElementById('${this.id}').component.send()}"></textarea>
                  <div class="composer-footer"><span>As gravações no repositório pedem aprovação.</span>${this.state.generating ? `<button class="secondary" onclick="document.getElementById('${this.id}').component.cancel()">Parar</button>` : `<button class="primary" onclick="document.getElementById('${this.id}').component.send()">Enviar</button>`}</div>
                </section>
              </main>
            ` : ''}

            ${this.state.pendingApproval ? `
              <div class="modal-backdrop" role="presentation">
                <section class="approval-modal" role="dialog" aria-modal="true" aria-labelledby="approval-title">
                  <p class="eyebrow">Ação de escrita</p>
                  <h2 id="approval-title">${escapeHtml(this.state.pendingApproval.title)}</h2>
                  <p>${escapeHtml(this.state.pendingApproval.description)}</p>
                  <pre>${escapeHtml(this.state.pendingApproval.preview)}</pre>
                  <div class="button-row"><button class="primary" onclick="document.getElementById('${this.id}').component.resolveApproval(true)">Aprovar e gravar</button><button class="secondary" onclick="document.getElementById('${this.id}').component.resolveApproval(false)">Cancelar</button></div>
                </section>
              </div>
            ` : ''}
          </section>
        `,
      }).content.firstElementChild)),
    );
  }
}

const app = component(AppComponent, {id: 'okf-chat-app'});
document.querySelector('#app-root').append(app.next().value);
void app.bootstrap();
