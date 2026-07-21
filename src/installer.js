import {loadLiteRtLm} from '@litert-lm/core';
import {component, escapeHtml, safeId} from './component.js';
import {loadConnection, removeConnection, saveConnection} from './crypto-store.js';
import {fetchRepositoryConfig} from './github.js';
import {deleteModel, downloadModel, formatBytes, hasModel, MODEL} from './model-store.js';
import {isStandalone, registerServiceWorker, warmInstalledApp} from './pwa.js';

function readForm() {
  return {
    owner: document.querySelector('#repo-owner')?.value.trim() ?? '',
    repo: document.querySelector('#repo-name')?.value.trim() ?? '',
    branch: document.querySelector('#repo-branch')?.value.trim() || 'main',
    configPath: document.querySelector('#repo-path')?.value.trim() || '.litert/config.json',
    token: document.querySelector('#repo-token')?.value.trim() ?? '',
    passphrase: document.querySelector('#local-passphrase')?.value ?? '',
  };
}

function* InstallerComponent({id, props = {}}) {
  this.id = safeId(id, 'installer');
  this.element = null;
  this.installPrompt = null;
  this.downloadController = null;
  this.state = {
    busy: false,
    status: 'Verificando ambiente…',
    error: '',
    connectionSaved: false,
    modelReady: false,
    progress: 0,
    downloaded: 0,
    total: MODEL.approximateBytes,
    installAvailable: false,
    installed: isStandalone(),
    owner: props.owner ?? '',
    repo: props.repo ?? '',
    branch: props.branch ?? 'main',
    configPath: props.configPath ?? '.litert/config.json',
    assistantName: '',
  };

  this.bootstrap = async () => {
    try {
      if (!navigator.gpu) {
        throw new Error('WebGPU não está disponível. Use Chromium/Chrome atualizado com aceleração de hardware ativa.');
      }
      await registerServiceWorker();
      await loadLiteRtLm('./wasm/');
      const [connection, modelReady] = await Promise.all([loadConnection(), hasModel()]);
      this.next({
        connectionSaved: Boolean(connection),
        modelReady,
        owner: connection?.owner ?? this.state.owner,
        repo: connection?.repo ?? this.state.repo,
        branch: connection?.branch ?? this.state.branch,
        configPath: connection?.configPath ?? this.state.configPath,
        status: modelReady
          ? 'Modelo local encontrado. Configure ou confirme o repositório.'
          : 'Configure o repositório e baixe o modelo.',
      });
    } catch (error) {
      this.next({error: error.message, status: 'Falha na inicialização.'});
    }
  };

  this.captureInstallPrompt = event => {
    event.preventDefault();
    this.installPrompt = event;
    this.next({installAvailable: true});
  };

  this.saveAndTest = async () => {
    if (this.state.busy) return;
    const form = readForm();

    if (!form.owner || !form.repo || !form.token) {
      this.next({error: 'Preencha proprietário, repositório e token.', status: 'Configuração incompleta.'});
      return;
    }

    this.next({
      busy: true,
      error: '',
      status: 'Testando acesso ao repositório…',
      owner: form.owner,
      repo: form.repo,
      branch: form.branch,
      configPath: form.configPath,
    });

    try {
      const config = await fetchRepositoryConfig(form);
      await saveConnection(form, form.token, form.passphrase);
      const tokenInput = document.querySelector('#repo-token');
      if (tokenInput) tokenInput.value = '';
      this.next({
        busy: false,
        connectionSaved: true,
        assistantName: config.assistant.name,
        owner: form.owner,
        repo: form.repo,
        branch: form.branch,
        configPath: form.configPath,
        status: `Conexão salva. Configuração de “${config.assistant.name}” validada.`,
      });
    } catch (error) {
      this.next({busy: false, error: error.message, status: 'Não foi possível salvar a conexão.'});
    }
  };

  this.startDownload = async () => {
    if (this.state.busy || this.state.modelReady) return;
    this.downloadController = new AbortController();
    this.next({busy: true, error: '', status: `Baixando ${MODEL.displayName}…`, progress: 0});

    try {
      let lastProgressUpdate = 0;
      await downloadModel({
        signal: this.downloadController.signal,
        onProgress: ({received, total, ratio}) => {
          const now = performance.now();
          if (ratio < 1 && now - lastProgressUpdate < 250) return;
          lastProgressUpdate = now;
          this.next({downloaded: received, total, progress: Math.round(ratio * 100)});
        },
      });
      await warmInstalledApp();
      this.next({
        busy: false,
        modelReady: true,
        progress: 100,
        status: 'Modelo e aplicativo preparados para uso offline.',
      });
    } catch (error) {
      const cancelled = error?.name === 'AbortError';
      this.next({
        busy: false,
        error: cancelled ? '' : error.message,
        status: cancelled ? 'Download cancelado.' : 'Falha ao baixar o modelo.',
      });
    } finally {
      this.downloadController = null;
    }
  };

  this.cancelDownload = () => this.downloadController?.abort();

  this.removeDownloadedModel = async () => {
    if (this.state.busy) return;
    this.next({busy: true, error: '', status: 'Removendo modelo local…'});
    try {
      await deleteModel();
      this.next({busy: false, modelReady: false, progress: 0, status: 'Modelo local removido.'});
    } catch (error) {
      this.next({busy: false, error: error.message, status: 'Falha ao remover o modelo.'});
    }
  };

  this.clearConnection = async () => {
    if (this.state.busy) return;
    await removeConnection();
    this.next({connectionSaved: false, assistantName: '', status: 'Conexão local removida.'});
  };

  this.install = async () => {
    if (!this.state.connectionSaved || !this.state.modelReady) {
      this.next({error: 'Salve a conexão e conclua o download antes de instalar.'});
      return;
    }

    if (!this.installPrompt) {
      this.next({
        error: '',
        status: 'Use o ícone de instalação na barra do Chromium ou o menu “Instalar aplicativo”.',
      });
      return;
    }

    await this.installPrompt.prompt();
    const choice = await this.installPrompt.userChoice;
    this.installPrompt = null;
    this.next({
      installAvailable: false,
      installed: choice.outcome === 'accepted',
      status: choice.outcome === 'accepted'
        ? 'Instalação aceita. Abra o aplicativo pelo menu do sistema.'
        : 'Instalação cancelada.',
    });
  };

  window.addEventListener('beforeinstallprompt', this.captureInstallPrompt);
  window.addEventListener('appinstalled', () => this.next({installed: true, status: 'PWA instalado.'}));

  while (true) {
    Object.assign(
      this.state,
      yield (this.element = ((element) => {
        element.id = this.id;
        element.component = this;
        if (this.element?.isConnected) this.element.replaceWith(element);
        return element;
      })(Object.assign(document.createElement('template'), {
        innerHTML: /* html */ `
          <section class="shell installer-shell" aria-labelledby="page-title">
            <header class="hero">
              <p class="eyebrow">LiteRT-LM · PWA local</p>
              <h1 id="page-title">Instalar assistente Gemma 4</h1>
              <p>Esta página apenas configura a instalação. O aplicativo instalado abre em uma tela separada e executa o modelo localmente.</p>
            </header>

            <div class="status ${this.state.error ? 'status-error' : ''}" role="status">
              <strong>${escapeHtml(this.state.status)}</strong>
              ${this.state.error ? `<span>${escapeHtml(this.state.error)}</span>` : ''}
            </div>

            <section class="card">
              <div class="step-heading">
                <span>1</span>
                <div><h2>Conectar ao repositório</h2><p>Use um token fine-grained limitado a um único repositório e com Contents: read.</p></div>
              </div>

              <div class="form-grid">
                <label>Proprietário
                  <input id="repo-owner" autocomplete="off" value="${escapeHtml(this.state.owner)}" placeholder="usuario-ou-organizacao">
                </label>
                <label>Repositório
                  <input id="repo-name" autocomplete="off" value="${escapeHtml(this.state.repo)}" placeholder="meu-assistente">
                </label>
                <label>Branch
                  <input id="repo-branch" autocomplete="off" value="${escapeHtml(this.state.branch)}" placeholder="main">
                </label>
                <label>Caminho do JSON
                  <input id="repo-path" autocomplete="off" value="${escapeHtml(this.state.configPath)}" placeholder=".litert/config.json">
                </label>
                <label class="full-width">GitHub token
                  <input id="repo-token" type="password" autocomplete="off" placeholder="github_pat_…">
                </label>
                <label class="full-width">Senha local para criptografar o token
                  <input id="local-passphrase" type="password" autocomplete="new-password" minlength="8" placeholder="mínimo de 8 caracteres">
                </label>
              </div>

              <div class="actions">
                <button class="primary" ${this.state.busy ? 'disabled' : ''} onclick="document.getElementById('${this.id}').component.saveAndTest()">
                  Testar e salvar conexão
                </button>
                ${this.state.connectionSaved ? `<button class="secondary" ${this.state.busy ? 'disabled' : ''} onclick="document.getElementById('${this.id}').component.clearConnection()">Remover conexão</button>` : ''}
              </div>
              <p class="result">${this.state.connectionSaved ? `Conexão cadastrada${this.state.assistantName ? ` para ${escapeHtml(this.state.assistantName)}` : ''}.` : 'Nenhuma conexão cadastrada.'}</p>
            </section>

            <section class="card">
              <div class="step-heading">
                <span>2</span>
                <div><h2>Baixar o modelo</h2><p>${escapeHtml(MODEL.displayName)} · aproximadamente ${escapeHtml(formatBytes(MODEL.approximateBytes))}.</p></div>
              </div>

              <progress max="100" value="${this.state.progress}">${this.state.progress}%</progress>
              <p class="result">${this.state.modelReady ? 'Modelo disponível no armazenamento privado do navegador.' : `${this.state.progress}% · ${escapeHtml(formatBytes(this.state.downloaded))} de ${escapeHtml(formatBytes(this.state.total))}`}</p>

              <div class="actions">
                ${this.state.busy && this.downloadController
                  ? `<button class="danger" onclick="document.getElementById('${this.id}').component.cancelDownload()">Cancelar download</button>`
                  : this.state.modelReady
                    ? `<button class="secondary" ${this.state.busy ? 'disabled' : ''} onclick="document.getElementById('${this.id}').component.removeDownloadedModel()">Remover modelo</button>`
                    : `<button class="primary" ${this.state.busy ? 'disabled' : ''} onclick="document.getElementById('${this.id}').component.startDownload()">Baixar Gemma 4</button>`}
              </div>
            </section>

            <section class="card">
              <div class="step-heading">
                <span>3</span>
                <div><h2>Instalar o PWA</h2><p>O aplicativo instalado usará a mesma origem e encontrará o modelo no OPFS.</p></div>
              </div>

              <div class="check-list">
                <span class="${this.state.connectionSaved ? 'ok' : ''}">Conexão configurada</span>
                <span class="${this.state.modelReady ? 'ok' : ''}">Modelo baixado</span>
                <span class="${this.state.installed ? 'ok' : ''}">PWA instalado</span>
              </div>

              <div class="actions">
                <button class="primary" ${(!this.state.connectionSaved || !this.state.modelReady || this.state.installed) ? 'disabled' : ''} onclick="document.getElementById('${this.id}').component.install()">
                  ${this.state.installed ? 'Aplicativo instalado' : this.state.installAvailable ? 'Instalar aplicativo' : 'Mostrar instrução de instalação'}
                </button>
                <a class="button-link secondary" href="./app.html">Abrir aplicativo no navegador</a>
              </div>
            </section>

            <aside class="security-note">
              <strong>Segurança</strong>
              <p>O token é criptografado com sua senha local e salvo no IndexedDB. A senha não é armazenada. Não use token classic nem permissão de escrita sem necessidade.</p>
            </aside>
          </section>
        `,
      }).content.firstElementChild)),
    );
  }
}

const installer = component(InstallerComponent, {id: 'installer'});
document.querySelector('#installer-root').append(installer.next().value);
installer.bootstrap();
