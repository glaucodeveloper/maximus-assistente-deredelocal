const SETUP_STATUS_ENDPOINT = "/api/setup/status";
const SETUP_CONFIGURE_ENDPOINT = "/api/setup/configure";
const SETUP_ACTIVATE_ENDPOINT = "/api/setup/activate";

const sleep = milliseconds =>
  new Promise(resolve => setTimeout(resolve, milliseconds));

async function readJson(response, endpoint) {
  const contentType =
    response.headers.get("content-type") || "";
  const text = await response.text();

  if (!contentType.toLowerCase().includes("application/json")) {
    throw new Error(
      `${endpoint} devolveu conteúdo incompatível.`,
    );
  }

  try {
    return text ? JSON.parse(text) : {};
  } catch (error) {
    throw new Error(
      `${endpoint} devolveu JSON inválido: ${error.message}`,
    );
  }
}

async function getSetupStatus() {
  const response = await fetch(
    SETUP_STATUS_ENDPOINT,
    {
      cache: "no-store",
      headers: { Accept: "application/json" },
    },
  );

  if (response.status === 404) {
    return null;
  }

  const data = await readJson(
    response,
    SETUP_STATUS_ENDPOINT,
  );

  if (!response.ok) {
    throw new Error(
      data.error || "Não foi possível consultar a configuração.",
    );
  }

  return data;
}

function createSetupOverlay(initialStatus) {
  const overlay = document.createElement("div");
  overlay.id = "engenharia-setup-overlay";
  overlay.className =
    "fixed inset-0 z-[100] bg-slate-950/90 backdrop-blur-md " +
    "flex items-center justify-center p-4 overflow-y-auto";

  overlay.innerHTML = `
    <section class="w-full max-w-xl rounded-3xl bg-white border border-slate-200 shadow-2xl overflow-hidden">
      <header class="bg-slate-950 px-7 py-6 text-white">
        <div class="flex items-center gap-4">
          <div class="w-12 h-12 rounded-2xl bg-blue-600 flex items-center justify-center">
            <i data-lucide="key-round" class="w-6 h-6"></i>
          </div>
          <div>
            <h1 class="text-lg font-bold">Configuração do servidor</h1>
            <p class="text-xs text-slate-400 mt-1">
              GitHub privado, vínculo da máquina e Gemma 4 E2B
            </p>
          </div>
        </div>
      </header>

      <div class="p-7">
        <div class="rounded-2xl bg-blue-50 border border-blue-100 p-4 mb-6">
          <p class="text-xs leading-relaxed text-blue-950">
            O PAT é enviado somente ao servidor Nim local em
            <strong>127.0.0.1</strong> e não é salvo no navegador.
            O token do Hugging Face foi configurado pelo patching.
            O destino é definido no próprio projeto:
            <strong>glaucodeveloper/maximus-engenharia-inteligente-data</strong>.
          </p>
        </div>

        <form id="engenharia-setup-form" class="space-y-4">
          <div>
            <label for="setup-github-pat" class="block text-xs font-bold text-slate-700 mb-1.5">
              Personal Access Token do GitHub
            </label>
            <input
              id="setup-github-pat"
              name="githubPat"
              type="password"
              required
              autocomplete="new-password"
              placeholder="github_pat_..."
              class="w-full px-4 py-3 rounded-xl border border-slate-200 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
            >
            <p class="text-[10px] text-slate-500 mt-1">
              Permissões necessárias: leitura do perfil e acesso ao conteúdo do repositório privado.
            </p>
          </div>

          <div class="rounded-xl bg-slate-50 border border-slate-200 px-4 py-3">
            <div class="flex justify-between gap-4 text-[10px]">
              <span class="font-bold text-slate-500">Máquina</span>
              <span id="setup-machine-id" class="font-mono text-slate-700 break-all text-right"></span>
            </div>
          </div>

          <div id="setup-error" class="hidden rounded-xl bg-red-50 border border-red-200 text-red-700 text-xs p-3"></div>

          <button
            id="setup-submit"
            type="submit"
            class="w-full rounded-xl bg-blue-600 hover:bg-blue-700 text-white font-bold text-sm px-5 py-3.5 transition"
          >
            Validar PAT e instalar
          </button>
        </form>

        <div id="setup-progress-panel" class="hidden">
          <div class="flex items-center gap-3 mb-5">
            <div class="w-10 h-10 rounded-xl bg-indigo-50 text-indigo-600 flex items-center justify-center">
              <i data-lucide="download-cloud" class="w-5 h-5"></i>
            </div>
            <div>
              <h2 class="text-sm font-bold text-slate-900">Preparando o servidor</h2>
              <p id="setup-phase-label" class="text-xs text-slate-500 mt-0.5"></p>
            </div>
          </div>

          <div class="h-3 bg-slate-200 rounded-full overflow-hidden">
            <div id="setup-progress-bar" class="h-full bg-indigo-600 transition-all duration-500" style="width: 0%"></div>
          </div>

          <div class="flex justify-between text-[10px] text-slate-500 mt-2 mb-5">
            <span id="setup-progress-message"></span>
            <span id="setup-progress-percent">0%</span>
          </div>

          <pre id="setup-log" class="max-h-40 overflow-auto rounded-xl bg-slate-950 text-slate-300 text-[10px] leading-relaxed p-4 whitespace-pre-wrap"></pre>

          <div id="setup-ready-actions" class="hidden mt-5">
            <button
              id="setup-activate"
              type="button"
              class="w-full rounded-xl bg-emerald-600 hover:bg-emerald-700 text-white font-bold text-sm px-5 py-3.5 transition"
            >
              Ativar EngenhariaNimServer
            </button>
          </div>

          <div id="setup-retry-actions" class="hidden mt-5">
            <button
              id="setup-retry"
              type="button"
              class="w-full rounded-xl bg-slate-800 hover:bg-slate-900 text-white font-bold text-sm px-5 py-3.5 transition"
            >
              Informar PAT novamente
            </button>
          </div>
        </div>
      </div>
    </section>
  `;

  document.body.append(overlay);
  window.lucide?.createIcons?.();

  const form = overlay.querySelector("#engenharia-setup-form");
  const progressPanel =
    overlay.querySelector("#setup-progress-panel");
  const machineId =
    overlay.querySelector("#setup-machine-id");
  const errorBox =
    overlay.querySelector("#setup-error");
  const submitButton =
    overlay.querySelector("#setup-submit");
  const phaseLabel =
    overlay.querySelector("#setup-phase-label");
  const progressMessage =
    overlay.querySelector("#setup-progress-message");
  const progressPercent =
    overlay.querySelector("#setup-progress-percent");
  const progressBar =
    overlay.querySelector("#setup-progress-bar");
  const logBox =
    overlay.querySelector("#setup-log");
  const readyActions =
    overlay.querySelector("#setup-ready-actions");
  const retryActions =
    overlay.querySelector("#setup-retry-actions");
  const activateButton =
    overlay.querySelector("#setup-activate");
  const retryButton =
    overlay.querySelector("#setup-retry");

  machineId.textContent =
    initialStatus?.machineId || "não identificado";

  const phaseLabels = {
    awaiting_credentials: "Aguardando credenciais",
    validating_github: "Validando o GitHub",
    creating_repository: "Preparando engenharia-data",
    protecting_credential: "Protegendo o PAT nesta máquina",
    downloading_model: "Baixando Gemma 4 E2B",
    starting_litert: "Inicializando LiteRT-LM",
    ready: "Configuração concluída",
    activating: "Ativando a aplicação",
    error: "Configuração interrompida",
  };

  function showError(message) {
    errorBox.textContent = message;
    errorBox.classList.remove("hidden");
  }

  function clearError() {
    errorBox.textContent = "";
    errorBox.classList.add("hidden");
  }

  function renderStatus(status) {
    if (!status) return;

    machineId.textContent =
      status.machineId || machineId.textContent;

    const phase =
      status.phase || "awaiting_credentials";
    const progress =
      Math.max(0, Math.min(100, Number(status.progress) || 0));

    phaseLabel.textContent =
      phaseLabels[phase] || phase;
    progressMessage.textContent =
      status.message || "";
    progressPercent.textContent =
      `${progress}%`;
    progressBar.style.width =
      `${progress}%`;
    logBox.textContent =
      status.logTail || "Aguardando registros...";

    const waiting =
      phase === "awaiting_credentials";
    const failed =
      phase === "error";
    const ready =
      phase === "ready";

    form.classList.toggle(
      "hidden",
      !waiting && !failed,
    );
    progressPanel.classList.toggle(
      "hidden",
      waiting,
    );
    readyActions.classList.toggle(
      "hidden",
      !ready,
    );
    retryActions.classList.toggle(
      "hidden",
      !failed,
    );

    if (failed && status.error) {
      showError(status.error);
    }
  }

  form.addEventListener("submit", async event => {
    event.preventDefault();
    clearError();
    submitButton.disabled = true;
    submitButton.textContent = "Validando...";

    const formData = new FormData(form);
    const payload = {
      githubPat:
        String(formData.get("githubPat") || "").trim(),
    };

    try {
      const response = await fetch(
        SETUP_CONFIGURE_ENDPOINT,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Accept: "application/json",
          },
          body: JSON.stringify(payload),
        },
      );

      const result = await readJson(
        response,
        SETUP_CONFIGURE_ENDPOINT,
      );

      if (!response.ok) {
        throw new Error(
          result.error || "Não foi possível iniciar a configuração.",
        );
      }

      form.querySelector(
        '[name="githubPat"]',
      ).value = "";
      form.classList.add("hidden");
      progressPanel.classList.remove("hidden");
      renderStatus(result);
    } catch (error) {
      showError(error.message);
      submitButton.disabled = false;
      submitButton.textContent =
        "Validar PAT e instalar";
    }
  });

  retryButton.addEventListener("click", () => {
    clearError();
    progressPanel.classList.add("hidden");
    form.classList.remove("hidden");
    submitButton.disabled = false;
    submitButton.textContent =
      "Validar PAT e instalar";
  });

  activateButton.addEventListener("click", async () => {
    activateButton.disabled = true;
    activateButton.textContent =
      "Ativando servidor definitivo...";

    try {
      const response = await fetch(
        SETUP_ACTIVATE_ENDPOINT,
        {
          method: "POST",
          headers: { Accept: "application/json" },
        },
      );

      const result = await readJson(
        response,
        SETUP_ACTIVATE_ENDPOINT,
      );

      if (!response.ok) {
        throw new Error(
          result.error || "Não foi possível ativar o servidor.",
        );
      }

      for (let attempt = 0; attempt < 90; attempt += 1) {
        await sleep(2000);

        try {
          const healthResponse = await fetch(
            "/api/health",
            {
              cache: "no-store",
              headers: { Accept: "application/json" },
            },
          );
          const health = await readJson(
            healthResponse,
            "/api/health",
          );

          if (
            healthResponse.ok &&
            health.runtime === "nim"
          ) {
            window.location.reload();
            return;
          }
        } catch {
          // Durante a troca, a porta fica brevemente indisponível.
        }
      }

      throw new Error(
        "O EngenhariaNimServer não assumiu a porta dentro do prazo.",
      );
    } catch (error) {
      showError(error.message);
      activateButton.disabled = false;
      activateButton.textContent =
        "Ativar EngenhariaNimServer";
    }
  });

  renderStatus(initialStatus);

  return {
    overlay,
    renderStatus,
    showError,
  };
}

export async function ensureApplicationSetup() {
  let initialStatus;

  try {
    initialStatus = await getSetupStatus();
  } catch (error) {
    console.warn(
      "[Setup] Consulta inicial ignorada:",
      error,
    );
    return;
  }

  if (
    !initialStatus ||
    initialStatus.setupRequired === false
  ) {
    return;
  }

  const view = createSetupOverlay(initialStatus);

  while (document.body.contains(view.overlay)) {
    await sleep(2000);

    try {
      const status = await getSetupStatus();

      if (!status) {
        return;
      }

      view.renderStatus(status);
    } catch (error) {
      view.showError(error.message);
    }
  }
}
