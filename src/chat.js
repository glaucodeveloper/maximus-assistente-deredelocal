import {Engine, loadLiteRtLm} from '@litert-lm/core';
import {component, escapeHtml, safeId} from './component.js';
import {loadConnection, unlockConnection} from './crypto-store.js';
import {fetchRepositoryConfig} from './github.js';
import {getModelFile, hasModel, MODEL} from './model-store.js';
import {registerServiceWorker} from './pwa.js';

function renderMessages(messages) {
  return messages.map(message => `
    <article class="message ${message.role}">
      <strong>${message.role === 'user' ? 'Você' : escapeHtml(message.name ?? 'Assistente')}</strong>
      <div>${escapeHtml(message.content)}</div>
    </article>
  `).join('');
}

function* ChatComponent({id}) {
  this.id = safeId(id, 'chat-app');
  this.element = null;
  this.engine = null;
  this.conversation = null;
  this.generating = false;
  this.pendingText = '';
  this.flushTimer = null;
  this.state = {
    phase: 'checking',
    status: 'Verificando instalação…',
    error: '',
    assistantName: 'Assistente local',
    messages: [],
    generating: false,
    hasConnection: false,
    hasModel: false,
  };

  this.bootstrap = async () => {
    try {
      await registerServiceWorker();
      const [connection, modelReady] = await Promise.all([loadConnection(), hasModel()]);
      this.next({
        phase: connection && modelReady ? 'locked' : 'missing',
        status: connection && modelReady
          ? 'Digite a senha local para desbloquear a conexão.'
          : 'A instalação ainda não está completa.',
        hasConnection: Boolean(connection),
        hasModel: modelReady,
      });
    } catch (error) {
      this.next({phase: 'missing', error: error.message, status: 'Falha ao verificar a instalação.'});
    }
  };

  this.unlock = async () => {
    if (this.state.phase === 'loading') return;
    const passphrase = document.querySelector('#unlock-passphrase')?.value ?? '';
    this.next({phase: 'loading', error: '', status: 'Desbloqueando conexão e carregando modelo…'});

    try {
      await loadLiteRtLm('./wasm/');
      const connection = await unlockConnection(passphrase);
      const [repoConfig, modelFile] = await Promise.all([
        fetchRepositoryConfig(connection),
        getModelFile(),
      ]);

      this.engine = await Engine.create({
        model: modelFile,
        mainExecutorSettings: {
          maxNumTokens: repoConfig.model.maxNumTokens,
        },
      });

      this.conversation = await this.engine.createConversation({
        preface: {
          messages: [{role: 'system', content: repoConfig.assistant.systemPrompt}],
        },
      });

      this.next({
        phase: 'ready',
        assistantName: repoConfig.assistant.name,
        status: `${MODEL.displayName} carregado localmente.`,
        messages: [{
          role: 'assistant',
          name: repoConfig.assistant.name,
          content: repoConfig.assistant.welcome,
        }],
      });
    } catch (error) {
      await this.dispose();
      this.next({phase: 'locked', error: error.message, status: 'Não foi possível abrir o aplicativo.'});
    }
  };

  this.scheduleFlush = messageIndex => {
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      const messages = this.state.messages.map((message, index) =>
        index === messageIndex ? {...message, content: this.pendingText} : message,
      );
      this.next({messages});
    }, 70);
  };

  this.send = async () => {
    if (!this.conversation || this.generating) return;
    const input = document.querySelector('#prompt-input');
    const text = input?.value.trim() ?? '';
    if (!text) return;

    this.generating = true;
    const assistantName = this.state.assistantName;
    const messages = [
      ...this.state.messages,
      {role: 'user', content: text},
      {role: 'assistant', name: assistantName, content: ''},
    ];
    const messageIndex = messages.length - 1;
    this.pendingText = '';
    this.next({messages, generating: true, error: '', status: 'Gerando resposta…'});

    try {
      const stream = this.conversation.sendMessageStreaming(text);
      for await (const chunk of stream) {
        for (const item of chunk.content ?? []) {
          if (item.type === 'text') {
            this.pendingText += item.text;
            this.scheduleFlush(messageIndex);
          }
        }
      }

      if (this.flushTimer) {
        clearTimeout(this.flushTimer);
        this.flushTimer = null;
      }
      const finalMessages = this.state.messages.map((message, index) =>
        index === messageIndex ? {...message, content: this.pendingText} : message,
      );
      this.next({messages: finalMessages, generating: false, status: 'Pronto.'});
    } catch (error) {
      const cancelled = error?.name === 'AbortError';
      this.next({
        generating: false,
        error: cancelled ? '' : error.message,
        status: cancelled ? 'Geração cancelada.' : 'A geração falhou.',
      });
    } finally {
      this.generating = false;
    }
  };

  this.cancel = () => {
    this.conversation?.cancel();
    this.generating = false;
    this.next({generating: false, status: 'Cancelando geração…'});
  };

  this.dispose = async () => {
    this.conversation?.cancel();
    this.conversation = null;
    if (this.engine) await this.engine.delete().catch(() => {});
    this.engine = null;
  };

  window.addEventListener('pagehide', () => void this.dispose(), {once: true});

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
          <section class="shell app-shell">
            <header class="app-header">
              <div><p class="eyebrow">LiteRT-LM · execução local</p><h1>${escapeHtml(this.state.assistantName)}</h1></div>
              <a class="button-link secondary" href="./index.html">Configuração</a>
            </header>

            <div class="status ${this.state.error ? 'status-error' : ''}" role="status">
              <strong>${escapeHtml(this.state.status)}</strong>
              ${this.state.error ? `<span>${escapeHtml(this.state.error)}</span>` : ''}
            </div>

            ${this.state.phase === 'checking' || this.state.phase === 'loading' ? `
              <section class="card centered"><div class="spinner" aria-hidden="true"></div><p>${escapeHtml(this.state.status)}</p></section>
            ` : ''}

            ${this.state.phase === 'missing' ? `
              <section class="card centered">
                <h2>Instalação incompleta</h2>
                <p>Conexão: ${this.state.hasConnection ? 'configurada' : 'ausente'} · Modelo: ${this.state.hasModel ? 'baixado' : 'ausente'}.</p>
                <a class="button-link primary" href="./index.html">Voltar ao instalador</a>
              </section>
            ` : ''}

            ${this.state.phase === 'locked' ? `
              <section class="card unlock-card">
                <h2>Desbloquear configuração</h2>
                <p>A senha é usada apenas para descriptografar o token nesta sessão.</p>
                <label>Senha local
                  <input id="unlock-passphrase" type="password" autocomplete="current-password" autofocus onkeydown="if(event.key==='Enter') document.getElementById('${this.id}').component.unlock()">
                </label>
                <button class="primary" onclick="document.getElementById('${this.id}').component.unlock()">Abrir assistente</button>
              </section>
            ` : ''}

            ${this.state.phase === 'ready' ? `
              <section class="chat-panel">
                <div class="messages" aria-live="polite">${renderMessages(this.state.messages)}</div>
                <form class="composer" onsubmit="document.getElementById('${this.id}').component.send(); return false;">
                  <label class="sr-only" for="prompt-input">Mensagem</label>
                  <textarea id="prompt-input" rows="3" placeholder="Digite uma mensagem…" ${this.state.generating ? 'disabled' : ''}></textarea>
                  <div class="actions">
                    <button class="primary" type="submit" ${this.state.generating ? 'disabled' : ''}>Enviar</button>
                    ${this.state.generating ? `<button class="danger" type="button" onclick="document.getElementById('${this.id}').component.cancel()">Parar</button>` : ''}
                  </div>
                </form>
              </section>
            ` : ''}
          </section>
        `,
      }).content.firstElementChild)),
    );
  }
}

const chat = component(ChatComponent, {id: 'chat-app'});
document.querySelector('#app-root').append(chat.next().value);
chat.bootstrap();
