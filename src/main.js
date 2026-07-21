import {Engine, loadLiteRtLm} from '@litert-lm/core';
import {component, escapeHtml, safeId} from './component.js';
import {clearGithubToken, loadGithubToken, saveGithubToken} from './device-store.js';
import {GitHubRepository, loadAppConfig} from './github.js';
import {loginUser, registerUser, verifyEmail} from './auth.js';
import {
  listOkfDocuments,
  listUserFiles,
  readOkfDocument,
  uploadUserFile,
} from './knowledge-store.js';
import {deleteModel, downloadModel, formatBytes, getModelFile, hasModel, MODEL} from './model-store.js';
import {buildRlmSystemPrompt, runRlm, UnsafeModelOutputError, validateModelEngine} from './rlm.js';
import {isStandalone, registerServiceWorker, warmInstalledApp} from './pwa.js';

let liteRtRuntimePromise = null;
function ensureLiteRtRuntime() {
  if (!liteRtRuntimePromise) liteRtRuntimePromise = loadLiteRtLm('./wasm/');
  return liteRtRuntimePromise;
}

function renderMessages(messages) {
  return messages.map(message => `
    <article class="message ${message.role}">
      <div class="message-label">${message.role === 'user' ? 'Você' : escapeHtml(message.name || 'Inteligência Maximus')}</div>
      <div class="message-content">${escapeHtml(message.content)}</div>
    </article>
  `).join('');
}

function renderFileList(files, componentId) {
  if (!files.length) return '<p class="empty-state">Seu espaço técnico ainda não possui artefatos. Adicione um documento para iniciar sua base de conhecimento.</p>';
  return files.map(file => `
    <article class="resource-card">
      <div class="resource-icon">${file.textReadable ? 'TXT' : 'BIN'}</div>
      <div class="resource-copy">
        <strong>${escapeHtml(file.name)}</strong>
        <span>${formatBytes(file.size)} · ${file.textReadable ? 'pronto para análise local' : 'preservado na base'}</span>
      </div>
      ${file.textReadable ? `<button class="icon-button" title="Analisar com a inteligência Maximus" onclick="document.getElementById('${componentId}').component.useFile('${encodeURIComponent(file.id)}')">→</button>` : ''}
    </article>
  `).join('');
}

function renderOkfList(documents, componentId) {
  if (!documents.length) return '<p class="empty-state">Nenhum conhecimento estruturado foi registrado ainda.</p>';
  return documents.slice(0, 80).map(document => `
    <article class="resource-card">
      <div class="resource-icon okf">OKF</div>
      <div class="resource-copy">
        <strong>${escapeHtml(document.name)}</strong>
        <span>${document.scope === 'base' ? 'conhecimento corporativo' : 'espaço individual'}</span>
      </div>
      <button class="icon-button" title="Analisar com a inteligência Maximus" onclick="document.getElementById('${componentId}').component.useOkf('${encodeURIComponent(document.path)}')">→</button>
    </article>
  `).join('');
}

function* AppComponent({id}) {
  this.id = safeId(id, 'maximus-intelligence-app');
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
  this.modelLoadPromise = null;

  this.state = {
    phase: 'boot',
    status: 'Preparando a experiência Maximus…',
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
    registration: null,
    verificationCompleted: false,
  };

  this.verificationParams = {
    userId: new URL(location.href).searchParams.get('verify_user') || '',
    token: new URL(location.href).searchParams.get('verify_token') || '',
  };

  this.patch = patch => this.next(patch);

  this.bootstrap = async () => {
    try {
      await registerServiceWorker();
      this.config = await loadAppConfig();
      const token = await loadGithubToken();
      if (!token) {
        this.patch({phase: 'token', status: 'Conecte este dispositivo à base privada da Maximus.', error: ''});
        return;
      }
      await this.connectWithToken(token, false);
    } catch (error) {
      this.patch({phase: 'token', status: 'A conexão segura precisa ser configurada.', error: error.message});
    }
  };

  this.connectWithToken = async (token, persist) => {
    if (this.state.busy) return;
    this.patch({busy: true, error: '', status: 'Validando o acesso à infraestrutura de conhecimento…'});
    try {
      if (!this.config) this.config = await loadAppConfig();
      const repository = new GitHubRepository({token, config: this.config});
      const identity = await repository.validate();
      await saveGithubToken(token, persist);
      this.token = token;
      this.repository = repository;

      if (this.verificationParams.userId && this.verificationParams.token) {
        const verifiedUser = await verifyEmail(repository, this.config, this.verificationParams);
        history.replaceState({}, document.title, location.pathname);
        this.verificationParams = {userId: '', token: ''};
        this.patch({
          busy: false,
          phase: 'auth',
          verificationCompleted: true,
          status: `Acesso ${verifiedUser.publicId} confirmado. Entre para iniciar seu ambiente técnico.`,
          githubUser: identity.user,
          repositoryInfo: identity.repository,
        });
        return;
      }

      this.patch({
        busy: false,
        phase: 'auth',
        status: 'Conexão autorizada. Entre ou crie seu acesso profissional.',
        githubUser: identity.user,
        repositoryInfo: identity.repository,
      });
    } catch (error) {
      this.patch({busy: false, phase: 'token', status: 'Não foi possível autorizar este dispositivo.', error: error.message});
    }
  };

  this.submitToken = async () => {
    const token = document.querySelector('#github-token')?.value.trim() || '';
    const remember = document.querySelector('#remember-token')?.checked === true;
    if (!token) {
      this.patch({error: 'Informe a chave autorizada para a base privada da Maximus.', status: 'A chave de acesso é necessária.'});
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
    const email = document.querySelector('#account-email')?.value || '';
    this.patch({busy: true, error: '', status: this.state.authMode === 'register' ? 'Estruturando seu espaço de inteligência técnica…' : 'Preparando seu ambiente técnico…'});

    try {
      const user = this.state.authMode === 'register'
        ? await registerUser(this.repository, this.config, {username, displayName, email, password})
        : await loginUser(this.repository, this.config, {username, password});

      if (user.pendingVerification) {
        this.patch({
          busy: false,
          phase: 'verify-email',
          registration: user,
          status: 'Solicitação registrada. Confirme seu e-mail corporativo para ativar o acesso.',
        });
        return;
      }

      this.user = user;
      await this.afterAuthentication(user);
    } catch (error) {
      this.patch({busy: false, status: 'Não foi possível concluir o acesso.', error: error.message});
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
      status: modelReady ? 'Ativando a inteligência já preparada neste dispositivo…' : 'Prepare a inteligência local para iniciar seu ambiente de engenharia.',
    });
    if (modelReady) await this.loadModel();
  };

  this.startModelDownload = async () => {
    if (this.state.busy || this.state.modelReady) return;
    this.downloadController = new AbortController();
    this.patch({busy: true, error: '', status: 'Transferindo o núcleo de inteligência Maximus…', progress: 0});
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
      this.patch({busy: false, modelReady: true, phase: 'loading-model', progress: 100, status: 'Núcleo local preparado. Ativando capacidades de análise…'});
      await this.loadModel();
    } catch (error) {
      const cancelled = error?.name === 'AbortError';
      this.patch({busy: false, status: cancelled ? 'A preparação foi interrompida.' : 'Não foi possível preparar a inteligência local.', error: cancelled ? '' : error.message});
    } finally {
      this.downloadController = null;
    }
  };

  this.cancelModelDownload = () => this.downloadController?.abort();

  this.createConversation = async () => {
    if (!this.engine) throw new Error('A inteligência local ainda não foi ativada.');
    this.conversation?.cancel?.();
    this.conversation = await this.engine.createConversation({
      preface: {messages: [{role: 'system', content: buildRlmSystemPrompt(this.config)}]},
    });
    return this.conversation;
  };

  this.loadModel = async ({force = false} = {}) => {
    if (this.modelLoadPromise && !force) return this.modelLoadPromise;
    this.modelLoadPromise = (async () => {
      try {
        this.patch({phase: 'loading-model', busy: true, error: '', status: 'Ativando a inteligência Maximus com aceleração local…'});
        if (!navigator.gpu) {
          throw new Error('A aceleração gráfica necessária não está disponível. Atualize o Chromium e habilite a aceleração de hardware.');
        }
        if (typeof WebAssembly.Suspending !== 'function' || typeof WebAssembly.promising !== 'function') {
          throw new Error('Este navegador ainda não oferece os recursos WebAssembly necessários. Utilize uma versão recente do Chromium no Manjaro.');
        }
        await ensureLiteRtRuntime();
        const modelFile = await getModelFile();
        await this.disposeModel();
        this.engine = await Engine.create({
          model: modelFile,
          mainExecutorSettings: {maxNumTokens: Math.min(2048, this.config.model.maxNumTokens)},
        });
        await validateModelEngine(this.engine);
        await this.createConversation();
        this.patch({
          phase: 'ready',
          busy: false,
          status: 'Inteligência local ativa e base Maximus conectada.',
          messages: [{role: 'assistant', name: this.config.assistant.name, content: this.config.assistant.welcome}],
        });
      } catch (error) {
        await this.disposeModel();
        if (error?.code === 'UNSAFE_MODEL_OUTPUT') {
          await deleteModel().catch(() => {});
        }
        const detail = error?.code === 'UNSAFE_MODEL_OUTPUT'
          ? 'O teste de integridade bloqueou uma saída inválida antes de exibi-la. O arquivo local foi removido; atualize o Chromium e os drivers gráficos antes de preparar novamente.'
          : error.message;
        this.patch({phase: 'model', busy: false, modelReady: false, status: 'Não foi possível ativar a inteligência local.', error: detail});
        throw error;
      } finally {
        this.modelLoadPromise = null;
      }
    })();
    return this.modelLoadPromise;
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
    this.patch({busy: true, error: '', status: `Incorporando ${file.name} ao seu espaço técnico…`});
    try {
      const metadata = await uploadUserFile(this.repository, this.config, this.user, file);
      if (input) input.value = '';
      await this.refreshResources();
      this.patch({busy: false, sidebarTab: 'files', status: `${metadata.name} foi incorporado ao seu espaço Maximus.`});
    } catch (error) {
      this.patch({busy: false, status: 'O artefato não pôde ser incorporado.', error: error.message});
    }
  };

  this.useFile = encodedId => {
    const fileId = decodeURIComponent(encodedId);
    const file = this.state.files.find(item => item.id === fileId);
    const input = document.querySelector('#prompt-input');
    if (input && file) {
      input.value = `Analise o artefato “${file.name}” e desenvolva: `;
      input.focus();
    }
  };

  this.useOkf = encodedPath => {
    const path = decodeURIComponent(encodedPath);
    const input = document.querySelector('#prompt-input');
    if (input) {
      input.value = `Consulte o conhecimento estruturado ${path} e desenvolva: `;
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
    this.patch({pendingApproval: approval, status: 'Aguardando sua aprovação para incorporar conhecimento à base Maximus…'});
  });

  this.resolveApproval = approved => {
    const resolver = this.approvalResolver;
    this.approvalResolver = null;
    this.patch({pendingApproval: null, status: approved ? 'Ação aprovada e registrada com rastreabilidade.' : 'A proposta foi descartada sem alterar a base.'});
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
    this.patch({messages, generating: true, error: '', status: 'Analisando o contexto técnico disponível…'});

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
        messages: [...this.state.messages, {role: 'assistant', name: this.config.assistant.name, content: answer || 'A análise não produziu conteúdo suficiente. Indique outro artefato ou detalhe o objetivo técnico.'}],
        generating: false,
        status: 'Análise concluída com a inteligência local Maximus.',
      });
    } catch (error) {
      const cancelled = error?.name === 'AbortError';
      if (error?.code === 'UNSAFE_MODEL_OUTPUT' || error instanceof UnsafeModelOutputError) {
        await this.disposeModel();
        await deleteModel().catch(() => {});
        this.patch({
          phase: 'model',
          modelReady: false,
          generating: false,
          status: 'A proteção de integridade interrompeu a inteligência local.',
          error: 'Nenhum token interno foi exibido. O modelo local foi removido para impedir nova ocorrência; prepare-o novamente após atualizar o navegador e o driver gráfico.',
        });
      } else {
        this.patch({generating: false, status: cancelled ? 'A análise foi interrompida.' : 'Não foi possível concluir a análise técnica.', error: cancelled ? '' : error.message});
      }
    } finally {
      this.generating = false;
    }
  };

  this.cancel = () => {
    this.conversation?.cancel();
    this.generating = false;
    this.patch({generating: false, status: 'Interrompendo a análise…'});
  };

  this.setSidebarTab = tab => this.patch({sidebarTab: tab === 'okf' ? 'okf' : 'files'});

  this.logout = async () => {
    await this.disposeModel();
    this.user = null;
    this.patch({phase: 'auth', user: null, messages: [], files: [], okfDocuments: [], status: 'Seu espaço foi encerrado com segurança.', error: ''});
  };

  this.disconnect = async () => {
    await this.disposeModel();
    await clearGithubToken();
    this.token = '';
    this.repository = null;
    this.user = null;
    this.patch({phase: 'token', githubUser: null, repositoryInfo: null, user: null, status: 'Conecte uma nova chave autorizada à base Maximus.', error: ''});
  };

  this.removeModel = async () => {
    await this.disposeModel();
    await deleteModel();
    this.patch({phase: 'model', modelReady: false, progress: 0, status: 'A inteligência local foi removida deste dispositivo.'});
  };

  this.captureInstallPrompt = event => {
    event.preventDefault();
    this.installPrompt = event;
    this.patch({installAvailable: true});
  };

  this.install = async () => {
    if (!this.installPrompt) {
      this.patch({status: 'Para instalar, abra o menu ⋮ do Chromium e escolha “Instalar Maximus Intelligence”.'});
      return;
    }
    await this.installPrompt.prompt();
    const result = await this.installPrompt.userChoice;
    this.installPrompt = null;
    this.patch({installAvailable: false, installed: result.outcome === 'accepted', status: result.outcome === 'accepted' ? 'Maximus Intelligence instalada neste dispositivo.' : 'A instalação foi cancelada.'});
  };

  this.disposeModel = async () => {
    this.conversation?.cancel();
    this.conversation = null;
    if (this.engine) await this.engine.delete().catch(() => {});
    this.engine = null;
  };

  window.addEventListener('beforeinstallprompt', this.captureInstallPrompt);
  window.addEventListener('appinstalled', () => this.patch({installed: true, installAvailable: false, status: 'Maximus Intelligence instalada e pronta para acesso rápido.'}));
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
                  <div class="brand-lockup"><div class="brand-mark">M</div><div><strong>MAXIMUS</strong><span>Engenharia Inteligente</span></div></div>
                  <p class="eyebrow">Conhecimento técnico transformado em decisão</p>
                  <h1>Acesse a inteligência técnica da Maximus</h1>
                  <p class="lead">Conecte este dispositivo à base privada de conhecimento da Maximus Empreendimentos. Sua credencial autoriza o acesso aos projetos, documentos e artefatos disponíveis para sua operação.</p>
                  <label class="field"><span>Chave de acesso ao GitHub</span><input id="github-token" type="password" autocomplete="off" placeholder="github_pat_…" ${this.state.busy ? 'disabled' : ''}></label>
                  <p class="field-help">Utilize uma chave autorizada exclusivamente para a base privada da Maximus.</p>
                  <label class="check"><input id="remember-token" type="checkbox" checked><span>Proteger e manter a chave neste dispositivo</span></label>
                  <button class="primary wide" ${this.state.busy ? 'disabled' : ''} onclick="document.getElementById('${this.id}').component.submitToken()">${this.state.busy ? 'Validando acesso…' : 'Conectar à base Maximus'}</button>
                  <p class="security-copy">A chave precisa de <strong>Contents: Read and write</strong>. Ela permanece fora das conversas e nunca é entregue ao modelo local.</p>
                  ${this.state.error ? `<div class="inline-error">${escapeHtml(this.state.error)}</div>` : ''}
                </section>
              </main>
            ` : ''}

            ${this.state.phase === 'auth' ? `
              <main class="gate">
                <section class="gate-card auth-card">
                  <div class="auth-context">
                    <div class="brand-mark small">M</div>
                    <div><strong>${escapeHtml(this.state.repositoryInfo?.fullName || '')}</strong><span>base autorizada por ${escapeHtml(this.state.githubUser?.login || '')}</span></div>
                  </div>
                  ${this.state.verificationCompleted ? `<div class="success-note"><strong>Acesso confirmado</strong><span>${escapeHtml(this.state.status)}</span></div>` : ''}
                  <div class="segmented">
                    <button class="${this.state.authMode === 'login' ? 'active' : ''}" onclick="document.getElementById('${this.id}').component.setAuthMode('login')">Entrar</button>
                    <button class="${this.state.authMode === 'register' ? 'active' : ''}" onclick="document.getElementById('${this.id}').component.setAuthMode('register')">Criar acesso</button>
                  </div>
                  <h1>${this.state.authMode === 'login' ? 'Bem-vindo à inteligência da Maximus' : 'Crie seu espaço de inteligência técnica'}</h1>
                  <p class="lead">${this.state.authMode === 'login' ? 'Entre no seu ambiente para consultar projetos, organizar artefatos e produzir conhecimento com inteligência local.' : 'Seu acesso organiza arquivos, análises e conhecimento estruturado em uma área individual vinculada à base Maximus.'}</p>
                  ${this.state.authMode === 'register' ? `
                    <label class="field"><span>Nome profissional</span><input id="account-display-name" autocomplete="name" maxlength="80" placeholder="Como você será identificado na plataforma"></label>
                    <label class="field"><span>E-mail corporativo</span><input id="account-email" type="email" autocomplete="email" maxlength="180" placeholder="nome@empresa.com.br"></label>
                  ` : ''}
                  <label class="field"><span>Identificador Maximus</span><input id="account-username" autocomplete="username" maxlength="32" placeholder="seu.identificador"></label>
                  <label class="field"><span>${this.state.authMode === 'login' ? 'Senha de acesso' : 'Crie uma senha'}</span><input id="account-password" type="password" autocomplete="${this.state.authMode === 'login' ? 'current-password' : 'new-password'}" placeholder="Mínimo de 10 caracteres"></label>
                  <button class="primary wide" ${this.state.busy ? 'disabled' : ''} onclick="document.getElementById('${this.id}').component.submitAuth()">${this.state.busy ? 'Preparando ambiente…' : this.state.authMode === 'login' ? 'Entrar no ambiente Maximus' : 'Solicitar acesso'}</button>
                  <button class="text-button" onclick="document.getElementById('${this.id}').component.disconnect()">Usar outra chave autorizada</button>
                  <p class="security-copy warning">Os espaços são separados por identificadores e pastas. A governança do repositório privado continua sendo responsável pelas permissões administrativas.</p>
                  ${this.state.error ? `<div class="inline-error">${escapeHtml(this.state.error)}</div>` : ''}
                </section>
              </main>
            ` : ''}

            ${this.state.phase === 'verify-email' ? `
              <main class="gate">
                <section class="gate-card confirmation-card">
                  <div class="brand-mark">M</div>
                  <p class="eyebrow">Identidade e rastreabilidade</p>
                  <h1>Seu acesso está em validação</h1>
                  <p class="lead">Enviamos as instruções de confirmação para <strong>${escapeHtml(this.state.registration?.email || '')}</strong>. Confirme o e-mail para ativar seu espaço privado de trabalho.</p>
                  <div class="identity-card"><span>Identificador único</span><strong>${escapeHtml(this.state.registration?.publicId || '')}</strong><small>Guarde este código para referências e auditoria.</small></div>
                  <p class="security-copy">A mensagem é emitida pelo fluxo seguro configurado no repositório de dados. O link expira conforme a política definida pela Maximus.</p>
                  <button class="secondary wide" onclick="document.getElementById('${this.id}').component.logout()">Voltar à entrada</button>
                </section>
              </main>
            ` : ''}

            ${this.state.phase === 'model' ? `
              <main class="gate">
                <section class="gate-card model-card">
                  <div class="brand-mark">AI</div>
                  <p class="eyebrow">Inteligência própria no dispositivo</p>
                  <h1>Prepare sua inteligência local</h1>
                  <p class="lead">O núcleo de inteligência da Maximus será armazenado neste dispositivo para analisar documentos e apoiar decisões técnicas com processamento local.</p>
                  <div class="benefit-grid"><span>Processamento local</span><span>Maior privacidade</span><span>Reutilização sem novo download</span><span>Operação com conexão limitada</span></div>
                  <div class="model-spec"><span>${MODEL.displayName}</span><strong>≈ ${formatBytes(MODEL.approximateBytes)}</strong></div>
                  <progress max="100" value="${this.state.progress}"></progress>
                  <p class="progress-copy">${this.state.progress ? `Preparando inteligência local: ${this.state.progress}% · ${formatBytes(this.state.downloaded)} de ${formatBytes(this.state.total)}` : 'Este recurso utiliza WebGPU e o armazenamento privado do navegador.'}</p>
                  <div class="button-row">
                    <button class="primary" ${this.state.busy ? 'disabled' : ''} onclick="document.getElementById('${this.id}').component.startModelDownload()">${this.state.busy ? 'Transferindo núcleo…' : 'Preparar inteligência Maximus'}</button>
                    ${this.state.busy ? `<button class="secondary" onclick="document.getElementById('${this.id}').component.cancelModelDownload()">Interromper preparação</button>` : ''}
                    <button class="secondary" onclick="document.getElementById('${this.id}').component.logout()">Sair com segurança</button>
                  </div>
                  <p class="security-copy">Mantenha esta tela aberta. Depois de concluído, o modelo será reutilizado nas próximas sessões deste dispositivo.</p>
                  ${this.state.error ? `<div class="inline-error">${escapeHtml(this.state.error)}</div>` : ''}
                </section>
              </main>
            ` : ''}

            ${this.state.phase === 'loading-model' ? `
              <main class="gate"><div class="loader"></div><h2>Ativando a inteligência Maximus</h2><p>${escapeHtml(this.state.status)}</p></main>
            ` : ''}

            ${this.state.phase === 'ready' ? `
              <aside class="sidebar">
                <div class="sidebar-brand"><div class="brand-mark small">M</div><div><strong>${escapeHtml(this.config?.assistant?.name || 'Maximus Intelligence')}</strong><span>engenharia · conhecimento · decisão</span></div></div>
                <div class="user-chip"><div class="avatar">${escapeHtml((this.state.user?.displayName || 'M').slice(0, 1).toUpperCase())}</div><div><strong>${escapeHtml(this.state.user?.displayName || '')}</strong><span>${escapeHtml(this.state.user?.publicId || `@${this.state.user?.username || ''}`)}</span></div></div>
                <button class="upload-button" ${this.state.busy ? 'disabled' : ''} onclick="document.getElementById('${this.id}').component.openUpload()">＋ Adicionar artefatos</button>
                <input id="file-upload" class="sr-only" type="file" onchange="document.getElementById('${this.id}').component.uploadSelected()">
                <div class="resource-tabs">
                  <button class="${this.state.sidebarTab === 'files' ? 'active' : ''}" onclick="document.getElementById('${this.id}').component.setSidebarTab('files')">Artefatos <span>${this.state.files.length}</span></button>
                  <button class="${this.state.sidebarTab === 'okf' ? 'active' : ''}" onclick="document.getElementById('${this.id}').component.setSidebarTab('okf')">Conhecimento <span>${this.state.okfDocuments.length}</span></button>
                </div>
                <div class="resource-list">${this.state.sidebarTab === 'files' ? renderFileList(this.state.files, this.id) : renderOkfList(this.state.okfDocuments, this.id)}</div>
                <section class="install-guide ${this.state.installed ? 'installed' : ''}">
                  <strong>${this.state.installed ? 'Aplicativo instalado' : 'Instale no seu dispositivo'}</strong>
                  <p>${this.state.installed ? 'A Maximus Intelligence já pode ser aberta como aplicativo e reutilizar a inteligência local.' : 'Clique no botão abaixo. Caso o navegador não abra a instalação, use o menu ⋮ do Chromium e escolha “Instalar Maximus Intelligence”.'}</p>
                  <button class="install-button" ${this.state.installed ? 'disabled' : ''} onclick="document.getElementById('${this.id}').component.install()">${this.state.installed ? 'Maximus Intelligence instalada' : 'Instalar aplicativo'}</button>
                </section>
                <div class="sidebar-footer">
                  <button class="text-button" onclick="document.getElementById('${this.id}').component.logout()">Encerrar meu espaço</button>
                  <button class="text-button danger-text" onclick="document.getElementById('${this.id}').component.disconnect()">Remover chave deste dispositivo</button>
                </div>
              </aside>
              <main class="chat-main">
                <header class="chat-header">
                  <div><p class="eyebrow">Inteligência própria · ferramentas controladas</p><h1>Conhecimento técnico em ação</h1></div>
                  <div class="runtime-pill"><span></span>${escapeHtml(this.state.status)}</div>
                </header>
                ${this.state.error ? `<div class="chat-error">${escapeHtml(this.state.error)}</div>` : ''}
                <section class="messages" aria-live="polite">${renderMessages(this.state.messages)}</section>
                <section class="composer">
                  <textarea id="prompt-input" rows="3" placeholder="Descreva a análise, documento ou decisão técnica que você precisa desenvolver…" ${this.state.generating ? 'disabled' : ''} onkeydown="if(event.key === 'Enter' && !event.shiftKey){event.preventDefault();document.getElementById('${this.id}').component.send()}"></textarea>
                  <div class="composer-footer"><span>Toda alteração na base exige sua aprovação.</span>${this.state.generating ? `<button class="secondary" onclick="document.getElementById('${this.id}').component.cancel()">Interromper análise</button>` : `<button class="primary" onclick="document.getElementById('${this.id}').component.send()">Analisar</button>`}</div>
                </section>
              </main>
            ` : ''}

            ${this.state.pendingApproval ? `
              <div class="modal-backdrop" role="presentation">
                <section class="approval-modal" role="dialog" aria-modal="true" aria-labelledby="approval-title">
                  <p class="eyebrow">A inteligência propõe uma ação</p>
                  <h2 id="approval-title">${escapeHtml(this.state.pendingApproval.title)}</h2>
                  <p>Revise os dados abaixo antes de autorizar qualquer alteração na base técnica.</p>
                  <p>${escapeHtml(this.state.pendingApproval.description)}</p>
                  <pre>${escapeHtml(this.state.pendingApproval.preview)}</pre>
                  <div class="button-row"><button class="primary" onclick="document.getElementById('${this.id}').component.resolveApproval(true)">Aprovar e registrar na base</button><button class="secondary" onclick="document.getElementById('${this.id}').component.resolveApproval(false)">Descartar proposta</button></div>
                </section>
              </div>
            ` : ''}
          </section>
        `,
      }).content.firstElementChild)),
    );
  }
}

const app = component(AppComponent, {id: 'maximus-intelligence-app'});
document.querySelector('#app-root').append(app.next().value);
void app.bootstrap();
