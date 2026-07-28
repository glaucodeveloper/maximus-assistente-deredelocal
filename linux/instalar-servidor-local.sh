#!/usr/bin/env bash
set -Eeuo pipefail

# Resolve o próprio arquivo antes de entrar no repositório.
SCRIPT_PATH="$(readlink -f "${BASH_SOURCE[0]}")"

PROJECT_DIR="${PROJECT_DIR:-$HOME/dev/engenharia}"
AUTO_PUSH="${AUTO_PUSH:-1}"
BRANCH="${BRANCH:-main}"
APP_PORT="${APP_PORT:-3001}"
LITERT_PORT="${LITERT_PORT:-9379}"
REPOSITORY_NAME="${REPOSITORY_NAME:-engenharia-data}"
MODEL_REPOSITORY="${MODEL_REPOSITORY:-litert-community/gemma-4-E2B-it-litert-lm}"
MODEL_FILE="${MODEL_FILE:-gemma-4-E2B-it.litertlm}"
MODEL_ALIAS="${MODEL_ALIAS:-gemma4-e2b}"
LITERT_BACKEND="${LITERT_BACKEND:-cpu}"

LEGACY_SERVICE="engenharia.service"
BOOTSTRAP_SERVICE="engenharia-bootstrap.service"
NIM_SERVICE="engenharia-nim.service"
LITERT_SERVICE="engenharia-litert.service"

info() { printf '\n==> %s\n' "$*"; }
warn() { printf '\nAVISO: %s\n' "$*" >&2; }
die() { printf '\nERRO: %s\n' "$*" >&2; exit 1; }

for command_name in \
  git node npm python3 curl nim systemctl sha256sum readlink
do
  command -v "$command_name" >/dev/null 2>&1 ||
    die "Comando ausente: $command_name"
done

command -v systemd-creds >/dev/null 2>&1 ||
  die "systemd-creds é obrigatório para proteger o PAT fora do navegador."

[[ -d "$PROJECT_DIR/.git" ]] ||
  die "$PROJECT_DIR não é um checkout Git."

cd "$PROJECT_DIR"

version="$(node -p 'require("./package.json").version')"

case "$version" in
  3.0.2|3.1.0|3.2.0) ;;
  *)
    die "Versão esperada 3.0.2, 3.1.0 ou 3.2.0; encontrada: $version"
    ;;
esac

if [[ -n "$(git status --porcelain)" ]]; then
  info "Continuando a migração parcial deixada pelo script 17"
  git status --short
fi

case "$(uname -m)" in
  x86_64|aarch64) ;;
  *)
    die "Arquitetura Linux não suportada: $(uname -m)"
    ;;
esac

timestamp="$(date +%Y%m%d-%H%M%S)"
backup_dir="${XDG_DATA_HOME:-$HOME/.local/share}/maximus-patches/interface-credentials-$timestamp"
mkdir -p "$backup_dir"

git bundle create "$backup_dir/repository.bundle" --all

tar \
  --exclude='./.git' \
  --exclude='./node_modules' \
  --exclude='./public/build' \
  --exclude='./dist' \
  --exclude='./.cache' \
  --exclude='./okf/db.sqlite-shm' \
  --exclude='./okf/db.sqlite-wal' \
  --warning=no-file-changed \
  -czf "$backup_dir/project.tar.gz" .

info "Selecionando o endereço MAC físico"

machine_interface=""

for interface_path in /sys/class/net/*; do
  interface_name="$(basename "$interface_path")"
  [[ "$interface_name" == "lo" ]] && continue

  if [[ -e "$interface_path/device" ]] &&
     [[ "$(cat "$interface_path/operstate" 2>/dev/null || true)" == "up" ]]
  then
    machine_interface="$interface_name"
    break
  fi
done

if [[ -z "$machine_interface" ]]; then
  for interface_path in /sys/class/net/*; do
    interface_name="$(basename "$interface_path")"
    [[ "$interface_name" == "lo" ]] && continue

    if [[ -e "$interface_path/device" ]]; then
      machine_interface="$interface_name"
      break
    fi
  done
fi

[[ -n "$machine_interface" ]] ||
  die "Nenhuma interface física foi localizada."

raw_mac="$(cat "/sys/class/net/$machine_interface/address")"
machine_mac="$(
  printf '%s' "$raw_mac" |
    tr -cd '[:xdigit:]' |
    tr '[:lower:]' '[:upper:]'
)"

[[ "${#machine_mac}" == "12" ]] ||
  die "MAC inválido para $machine_interface: $raw_mac"

machine_hash="$(
  printf '%s' "$machine_mac" |
    sha256sum |
    awk '{print $1}'
)"

printf 'Interface: %s\n' "$machine_interface"
printf 'Identificador SHA-256: %s\n' "$machine_hash"

mkdir -p \
  src/client \
  nim-server/src \
  linux \
  dist

info "Criando a interface de credenciais"

cat > src/client/setup-bootstrap.js <<'JS'
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
            As credenciais são enviadas somente ao servidor Nim local em
            <strong>127.0.0.1</strong>. O PAT não é salvo no navegador.
            No servidor, ele é criptografado com <strong>systemd-creds</strong>
            e a instalação continua vinculada ao MAC desta máquina.
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

          <div>
            <label for="setup-hf-token" class="block text-xs font-bold text-slate-700 mb-1.5">
              Token do Hugging Face
            </label>
            <input
              id="setup-hf-token"
              name="huggingFaceToken"
              type="password"
              required
              autocomplete="new-password"
              placeholder="hf_..."
              class="w-full px-4 py-3 rounded-xl border border-slate-200 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
            >
            <p class="text-[10px] text-slate-500 mt-1">
              Usado uma única vez para baixar o Gemma 4 E2B. Não será persistido.
            </p>
          </div>

          <div>
            <label for="setup-repository" class="block text-xs font-bold text-slate-700 mb-1.5">
              Repositório privado de dados
            </label>
            <input
              id="setup-repository"
              name="repositoryName"
              type="text"
              required
              value="engenharia-data"
              pattern="[A-Za-z0-9._-]{1,100}"
              autocomplete="off"
              class="w-full px-4 py-3 rounded-xl border border-slate-200 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
            >
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
            Validar credenciais e instalar
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
              Informar credenciais novamente
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
      huggingFaceToken:
        String(formData.get("huggingFaceToken") || "").trim(),
      repositoryName:
        String(formData.get("repositoryName") || "").trim(),
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
      form.querySelector(
        '[name="huggingFaceToken"]',
      ).value = "";

      form.classList.add("hidden");
      progressPanel.classList.remove("hidden");
      renderStatus(result);
    } catch (error) {
      showError(error.message);
      submitButton.disabled = false;
      submitButton.textContent =
        "Validar credenciais e instalar";
    }
  });

  retryButton.addEventListener("click", () => {
    clearError();
    progressPanel.classList.add("hidden");
    form.classList.remove("hidden");
    submitButton.disabled = false;
    submitButton.textContent =
      "Validar credenciais e instalar";
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
JS

python3 <<'PY'
from pathlib import Path

app_path = Path("public/app.js")
app = app_path.read_text(encoding="utf-8")

bootstrap_import = '''import {
  ensureApplicationSetup,
} from "../src/client/setup-bootstrap.js";

await ensureApplicationSetup();

'''

if "ensureApplicationSetup" not in app:
    app = bootstrap_import + app

app_path.write_text(app, encoding="utf-8")

index_path = Path("public/index.html")
index = index_path.read_text(encoding="utf-8")
index = index.replace(
    "<title>Engenharia — Central RAG & FTP OKF</title>",
    "<title>Engenharia — Documentação e IA Local</title>",
)
index_path.write_text(index, encoding="utf-8")
PY

info "Criando o servidor Nim de configuração"

cat > nim-server/src/engenharia_setup.nim <<'NIM'
import std/[
  asyncdispatch,
  asynchttpserver,
  httpcore,
  json,
  os,
  osproc,
  strtabs,
  strutils,
  uri
]

type SetupConfig = object
  port: Port
  publicDir: string
  projectDir: string
  statePath: string
  logPath: string
  setupHelper: string
  activateHelper: string
  machineId: string
  machineMac: string
  repositoryName: string
  mainConfigPath: string
  secretPath: string
  litertDir: string
  litertBin: string
  litertUrl: string
  modelRepository: string
  modelFile: string
  modelAlias: string

var setupProcess: Process = nil

proc jsonHeaders(): HttpHeaders =
  newHttpHeaders([
    ("Content-Type", "application/json; charset=utf-8"),
    ("Cache-Control", "no-store"),
    ("X-Content-Type-Options", "nosniff"),
    ("X-Frame-Options", "DENY"),
    ("Referrer-Policy", "no-referrer")
  ])

proc textHeaders(kind: string): HttpHeaders =
  newHttpHeaders([
    ("Content-Type", kind),
    ("Cache-Control", "no-store"),
    ("X-Content-Type-Options", "nosniff")
  ])

proc loadConfig(path: string): SetupConfig =
  let node = parseFile(path)

  result.port = Port(node{"port"}.getInt(3001))
  result.publicDir = node{"publicDir"}.getStr
  result.projectDir = node{"projectDir"}.getStr
  result.statePath = node{"statePath"}.getStr
  result.logPath = node{"logPath"}.getStr
  result.setupHelper = node{"setupHelper"}.getStr
  result.activateHelper = node{"activateHelper"}.getStr
  result.machineId = node{"machineId"}.getStr
  result.machineMac = node{"machineMac"}.getStr
  result.repositoryName =
    node{"repositoryName"}.getStr("engenharia-data")
  result.mainConfigPath = node{"mainConfigPath"}.getStr
  result.secretPath = node{"secretPath"}.getStr
  result.litertDir = node{"litertDir"}.getStr
  result.litertBin = node{"litertBin"}.getStr
  result.litertUrl =
    node{"litertUrl"}.getStr("http://127.0.0.1:9379")
  result.modelRepository = node{"modelRepository"}.getStr
  result.modelFile = node{"modelFile"}.getStr
  result.modelAlias = node{"modelAlias"}.getStr("gemma4-e2b")

proc defaultState(c: SetupConfig): JsonNode =
  %*{
    "runtime": "setup-nim",
    "setupRequired": true,
    "phase": "awaiting_credentials",
    "progress": 0,
    "message": "Informe as credenciais na interface.",
    "machineId": c.machineId,
    "repositoryName": c.repositoryName,
    "logTail": ""
  }

proc readLogTail(path: string, maximum = 6000): string =
  if not fileExists(path):
    return ""

  let content = readFile(path)

  if content.len <= maximum:
    return content

  content[content.len - maximum .. ^1]

proc readState(c: SetupConfig): JsonNode =
  if not fileExists(c.statePath):
    result = defaultState(c)
  else:
    try:
      result = parseFile(c.statePath)
    except CatchableError:
      result = defaultState(c)

  result["runtime"] = %"setup-nim"
  result["setupRequired"] = %true
  result["machineId"] = %c.machineId
  result["repositoryName"] =
    %result{"repositoryName"}.getStr(c.repositoryName)
  result["logTail"] = %readLogTail(c.logPath)

proc writeState(c: SetupConfig, state: JsonNode) =
  createDir(c.statePath.parentDir)
  writeFile(c.statePath, pretty(state) & "\n")

proc safeStaticPath(c: SetupConfig, requestPath: string): string =
  var relative =
    if requestPath == "/" or requestPath.len == 0:
      "index.html"
    else:
      decodeUrl(requestPath).strip(chars = {'/'})

  if relative.contains("..") or relative.contains('\\'):
    return ""

  result = c.publicDir / relative

  if not fileExists(result):
    result = c.publicDir / "index.html"

proc mimeType(path: string): string =
  case path.splitFile.ext.toLowerAscii
  of ".html": "text/html; charset=utf-8"
  of ".js": "text/javascript; charset=utf-8"
  of ".css": "text/css; charset=utf-8"
  of ".json": "application/json; charset=utf-8"
  of ".svg": "image/svg+xml"
  of ".png": "image/png"
  of ".jpg", ".jpeg": "image/jpeg"
  of ".ico": "image/x-icon"
  of ".wasm": "application/wasm"
  else: "application/octet-stream"

proc childEnvironment(
  c: SetupConfig,
  githubPat: string,
  huggingFaceToken: string,
  repositoryName: string
): StringTableRef =
  result = newStringTable(modeCaseSensitive)

  for key, value in envPairs():
    result[key] = value

  result["GITHUB_PAT"] = githubPat
  result["HF_TOKEN"] = huggingFaceToken
  result["REPOSITORY_NAME"] = repositoryName
  result["MACHINE_ID"] = c.machineId
  result["MACHINE_MAC"] = c.machineMac
  result["PROJECT_DIR"] = c.projectDir
  result["PUBLIC_DIR"] = c.publicDir
  result["STATE_PATH"] = c.statePath
  result["SETUP_LOG_PATH"] = c.logPath
  result["MAIN_CONFIG_PATH"] = c.mainConfigPath
  result["SECRET_PATH"] = c.secretPath
  result["LITERT_DIR"] = c.litertDir
  result["LITERT_BIN"] = c.litertBin
  result["LITERT_URL"] = c.litertUrl
  result["MODEL_REPOSITORY"] = c.modelRepository
  result["MODEL_FILE"] = c.modelFile
  result["MODEL_ALIAS"] = c.modelAlias

proc startConfiguration(
  c: SetupConfig,
  githubPat: string,
  huggingFaceToken: string,
  repositoryName: string
) =
  if setupProcess != nil and running(setupProcess):
    raise newException(
      IOError,
      "Uma configuração já está em andamento."
    )

  let state = %*{
    "runtime": "setup-nim",
    "setupRequired": true,
    "phase": "validating_github",
    "progress": 5,
    "message": "Validando o Personal Access Token...",
    "machineId": c.machineId,
    "repositoryName": repositoryName
  }

  writeState(c, state)

  setupProcess = startProcess(
    c.setupHelper,
    workingDir = c.projectDir,
    env = childEnvironment(
      c,
      githubPat,
      huggingFaceToken,
      repositoryName
    ),
    options = {poUsePath, poParentStreams}
  )

proc activateMain(c: SetupConfig) =
  let state = readState(c)

  if state{"phase"}.getStr != "ready":
    raise newException(
      IOError,
      "A configuração ainda não está pronta para ativação."
    )

  discard startProcess(
    "systemd-run",
    args = [
      "--user",
      "--unit=engenharia-activate",
      "--collect",
      c.activateHelper
    ],
    options = {poUsePath, poParentStreams}
  )

  state["phase"] = %"activating"
  state["progress"] = %100
  state["message"] =
    %"Transferindo a porta para EngenhariaNimServer..."
  writeState(c, state)

proc respondJson(
  req: Request,
  code: HttpCode,
  node: JsonNode
) {.async.} =
  await req.respond(code, $node, jsonHeaders())

proc configPath(): string =
  result = getEnv(
    "ENGINEERING_SETUP_CONFIG",
    getCurrentDir() / "setup-config.json"
  )

  for argument in commandLineParams():
    if argument.startsWith("--config="):
      result = argument.substr("--config=".len)

proc main() =
  let c = loadConfig(configPath())
  createDir(c.statePath.parentDir)
  createDir(c.logPath.parentDir)

  if not fileExists(c.statePath):
    writeState(c, defaultState(c))

  var server = newAsyncHttpServer()

  proc handleRequest(req: Request) {.async.} =
    try:
      let path = req.url.path

      if path == "/api/setup/status" and
          req.reqMethod == HttpGet:
        await respondJson(req, Http200, readState(c))
        return

      if path == "/api/setup/configure" and
          req.reqMethod == HttpPost:
        if req.body.len > 32 * 1024:
          await respondJson(req, Http413, %*{
            "error": "Requisição de configuração excessiva."
          })
          return

        let input = parseJson(req.body)
        let githubPat =
          input{"githubPat"}.getStr.strip
        let huggingFaceToken =
          input{"huggingFaceToken"}.getStr.strip
        let repositoryName =
          input{"repositoryName"}.getStr.strip

        if githubPat.len < 20:
          await respondJson(req, Http400, %*{
            "error": "Informe um PAT do GitHub válido."
          })
          return

        if huggingFaceToken.len < 10:
          await respondJson(req, Http400, %*{
            "error": "Informe o token do Hugging Face."
          })
          return

        if repositoryName.len == 0 or
            repositoryName.len > 100:
          await respondJson(req, Http400, %*{
            "error": "Nome de repositório inválido."
          })
          return

        for ch in repositoryName:
          if not (
            ch.isAlphaNumeric or
            ch in {'-', '_', '.'}
          ):
            await respondJson(req, Http400, %*{
              "error": "O repositório contém caracteres inválidos."
            })
            return

        startConfiguration(
          c,
          githubPat,
          huggingFaceToken,
          repositoryName
        )

        await respondJson(req, Http202, readState(c))
        return

      if path == "/api/setup/activate" and
          req.reqMethod == HttpPost:
        activateMain(c)
        await respondJson(req, Http202, %*{
          "success": true,
          "message": "Ativação iniciada."
        })
        return

      if path == "/api/health":
        let state = readState(c)
        await respondJson(req, Http200, %*{
          "ok": true,
          "runtime": "setup-nim",
          "setupRequired": true,
          "phase": state{"phase"}.getStr,
          "machineId": c.machineId
        })
        return

      if path.startsWith("/api/"):
        await respondJson(req, Http503, %*{
          "error": "Conclua a configuração inicial na interface.",
          "runtime": "setup-nim",
          "setupRequired": true
        })
        return

      let filePath = safeStaticPath(c, path)

      if filePath.len == 0 or not fileExists(filePath):
        await req.respond(
          Http404,
          "Arquivo não encontrado.",
          textHeaders("text/plain; charset=utf-8")
        )
        return

      await req.respond(
        Http200,
        readFile(filePath),
        textHeaders(mimeType(filePath))
      )
    except CatchableError as error:
      stderr.writeLine("[Setup Nim] ", error.msg)
      await respondJson(req, Http500, %*{
        "error": error.msg
      })

  proc callback(req: Request) {.async, gcsafe.} =
    {.cast(gcsafe).}:
      await handleRequest(req)

  echo "Engenharia Setup Nim em http://127.0.0.1:", int(c.port)
  waitFor server.serve(
    c.port,
    callback,
    address = "127.0.0.1"
  )

when isMainModule:
  main()
NIM

info "Criando o configurador executado pelo servidor Nim"

cat > linux/setup-configure.py <<'PY'
#!/usr/bin/env python3

from __future__ import annotations

import base64
import json
import os
import pathlib
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone


def required(name: str) -> str:
    value = os.environ.get(name, "").strip()
    if not value:
        raise RuntimeError(f"Variável obrigatória ausente: {name}")
    return value


state_path = pathlib.Path(required("STATE_PATH"))
log_path = pathlib.Path(required("SETUP_LOG_PATH"))
main_config_path = pathlib.Path(required("MAIN_CONFIG_PATH"))
secret_path = pathlib.Path(required("SECRET_PATH"))
project_dir = pathlib.Path(required("PROJECT_DIR"))
public_dir = pathlib.Path(required("PUBLIC_DIR"))
litert_dir = pathlib.Path(required("LITERT_DIR"))
litert_bin = required("LITERT_BIN")
litert_url = required("LITERT_URL")
model_repository = required("MODEL_REPOSITORY")
model_file = required("MODEL_FILE")
model_alias = required("MODEL_ALIAS")
machine_id = required("MACHINE_ID")
machine_mac = required("MACHINE_MAC")
repository_name = required("REPOSITORY_NAME")
github_pat = required("GITHUB_PAT")
hf_token = required("HF_TOKEN")

log_path.parent.mkdir(parents=True, exist_ok=True)
log_stream = log_path.open("a", encoding="utf-8", buffering=1)
sys.stdout = log_stream
sys.stderr = log_stream

os.environ.pop("GITHUB_PAT", None)
os.environ.pop("HF_TOKEN", None)


def write_state(
    phase: str,
    progress: int,
    message: str,
    *,
    error: str = "",
    repository: str = "",
) -> None:
    state_path.parent.mkdir(parents=True, exist_ok=True)

    payload = {
        "runtime": "setup-nim",
        "setupRequired": True,
        "phase": phase,
        "progress": progress,
        "message": message,
        "error": error,
        "machineId": machine_id,
        "repositoryName": repository_name,
        "repository": repository,
        "updatedAt": datetime.now(timezone.utc).isoformat(),
    }

    temporary = state_path.with_suffix(".tmp")
    temporary.write_text(
        json.dumps(payload, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    temporary.replace(state_path)


def github_request(
    method: str,
    url: str,
    payload: dict | None = None,
) -> tuple[int, dict]:
    headers = {
        "Accept": "application/vnd.github+json",
        "Authorization": f"Bearer {github_pat}",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "engenharia-interface-setup/3.2",
    }

    data = (
        json.dumps(payload).encode("utf-8")
        if payload is not None
        else None
    )

    request = urllib.request.Request(
        url,
        data=data,
        headers=headers,
        method=method,
    )

    try:
        with urllib.request.urlopen(
            request,
            timeout=60,
        ) as response:
            raw = response.read().decode("utf-8")
            return (
                response.status,
                json.loads(raw) if raw else {},
            )
    except urllib.error.HTTPError as error:
        raw = error.read().decode(
            "utf-8",
            errors="replace",
        )

        try:
            details = json.loads(raw)
        except json.JSONDecodeError:
            details = {"message": raw}

        return error.code, details


def put_repo_file(
    repository_url: str,
    path: str,
    content: str,
    message: str,
) -> None:
    encoded_path = "/".join(
        urllib.parse.quote(part, safe="")
        for part in path.split("/")
    )
    url = f"{repository_url}/contents/{encoded_path}"

    status, current = github_request("GET", url)

    body = {
        "message": message,
        "content": base64.b64encode(
            content.encode("utf-8")
        ).decode("ascii"),
        "branch": "main",
    }

    if status == 200:
        body["sha"] = current["sha"]
    elif status != 404:
        raise RuntimeError(
            f"Falha ao consultar {path}: HTTP {status}: "
            f"{current.get('message', current)}"
        )

    status, saved = github_request(
        "PUT",
        url,
        body,
    )

    if status not in (200, 201):
        raise RuntimeError(
            f"Falha ao gravar {path}: HTTP {status}: "
            f"{saved.get('message', saved)}"
        )


def encrypt_pat() -> None:
    secret_path.parent.mkdir(
        parents=True,
        exist_ok=True,
    )

    with tempfile.NamedTemporaryFile(
        dir=secret_path.parent,
        prefix="github-pat-",
        suffix=".cred",
        delete=False,
    ) as temporary:
        temporary_path = pathlib.Path(temporary.name)

    try:
        result = subprocess.run(
            [
                "systemd-creds",
                "encrypt",
                "--user",
                "--name=github-pat",
                "-",
                str(temporary_path),
            ],
            input=github_pat.encode("utf-8"),
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            check=False,
        )

        if result.returncode != 0:
            raise RuntimeError(
                "systemd-creds recusou a proteção do PAT: "
                + result.stderr.decode(
                    "utf-8",
                    errors="replace",
                ).strip()
            )

        temporary_path.chmod(0o600)
        temporary_path.replace(secret_path)
    finally:
        temporary_path.unlink(missing_ok=True)


def wait_litert(timeout_seconds: int = 240) -> None:
    deadline = time.monotonic() + timeout_seconds
    endpoint = f"{litert_url}/v1/models"

    while time.monotonic() < deadline:
        try:
            with urllib.request.urlopen(
                endpoint,
                timeout=5,
            ) as response:
                if response.status == 200:
                    return
        except Exception:
            pass

        time.sleep(2)

    raise RuntimeError(
        "LiteRT-LM não respondeu em /v1/models."
    )


try:
    log_path.write_text("", encoding="utf-8")

    write_state(
        "validating_github",
        8,
        "Validando o Personal Access Token do GitHub...",
    )

    status, user = github_request(
        "GET",
        "https://api.github.com/user",
    )

    if status != 200:
        raise RuntimeError(
            f"GitHub recusou o PAT: HTTP {status}: "
            f"{user.get('message', user)}"
        )

    owner = user["login"]
    display_name = user.get("name") or owner
    repository_url = (
        f"https://api.github.com/repos/"
        f"{owner}/{repository_name}"
    )

    write_state(
        "creating_repository",
        18,
        f"Preparando {owner}/{repository_name}...",
        repository=f"{owner}/{repository_name}",
    )

    status, repository = github_request(
        "GET",
        repository_url,
    )

    if status == 404:
        status, repository = github_request(
            "POST",
            "https://api.github.com/user/repos",
            {
                "name": repository_name,
                "description":
                    "Dados privados da aplicação Engenharia",
                "private": True,
                "auto_init": True,
            },
        )

        if status != 201:
            raise RuntimeError(
                "Não foi possível criar o repositório: "
                f"HTTP {status}: "
                f"{repository.get('message', repository)}"
            )

        time.sleep(2)
    elif status != 200:
        raise RuntimeError(
            "Não foi possível consultar o repositório: "
            f"HTTP {status}: "
            f"{repository.get('message', repository)}"
        )

    if not repository.get("private", False):
        raise RuntimeError(
            f"{owner}/{repository_name} precisa ser privado."
        )

    put_repo_file(
        repository_url,
        "documents/README.md",
        "# Engenharia Data\n\n"
        "Repositório privado usado pelo servidor Nim.\n",
        "Inicializar documentos de Engenharia",
    )

    put_repo_file(
        repository_url,
        "state/tasks.json",
        "[]\n",
        "Inicializar atividades de Engenharia",
    )

    machine_record = (
        json.dumps(
            {
                "machineId": machine_id,
                "macHash": machine_id,
                "host": os.uname().nodename,
                "registeredAt":
                    datetime.now(timezone.utc).isoformat(),
                "application": "Engenharia",
                "rawMacStored": False,
            },
            ensure_ascii=False,
            indent=2,
        )
        + "\n"
    )

    put_repo_file(
        repository_url,
        f"machines/{machine_id}.json",
        machine_record,
        "Registrar servidor local de Engenharia",
    )

    write_state(
        "protecting_credential",
        30,
        "Criptografando o PAT para esta máquina...",
        repository=f"{owner}/{repository_name}",
    )

    encrypt_pat()

    main_config_path.parent.mkdir(
        parents=True,
        exist_ok=True,
    )

    main_config = {
        "port": 3001,
        "publicDir": str(public_dir),
        "secretPath": str(secret_path),
        "githubOwner": owner,
        "githubRepo": repository_name,
        "githubBranch": "main",
        "macHash": machine_id,
        "litertBaseUrl": litert_url,
        "modelAlias": model_alias,
        "displayName": display_name,
    }

    main_config_path.write_text(
        json.dumps(
            main_config,
            ensure_ascii=False,
            indent=2,
        )
        + "\n",
        encoding="utf-8",
    )
    main_config_path.chmod(0o600)

    model_path = (
        litert_dir
        / "models"
        / model_alias
        / "model.litertlm"
    )

    if (
        not model_path.exists()
        or model_path.stat().st_size < 1_000_000_000
    ):
        write_state(
            "downloading_model",
            45,
            "Baixando e importando Gemma 4 E2B...",
            repository=f"{owner}/{repository_name}",
        )

        child_env = os.environ.copy()
        child_env["HF_TOKEN"] = hf_token
        child_env["LITERT_LM_DIR"] = str(litert_dir)

        completed = subprocess.run(
            [
                litert_bin,
                "import",
                f"--from-huggingface-repo={model_repository}",
                model_file,
                model_alias,
            ],
            env=child_env,
            cwd=project_dir,
            check=False,
        )

        child_env.pop("HF_TOKEN", None)

        if completed.returncode != 0:
            raise RuntimeError(
                "A importação do Gemma 4 E2B falhou. "
                "Consulte o registro exibido na interface."
            )

    if not model_path.exists():
        raise RuntimeError(
            "O arquivo importado do Gemma 4 não foi localizado."
        )

    write_state(
        "starting_litert",
        88,
        "Iniciando o servidor LiteRT-LM...",
        repository=f"{owner}/{repository_name}",
    )

    subprocess.run(
        [
            "systemctl",
            "--user",
            "enable",
            "--now",
            "engenharia-litert.service",
        ],
        check=True,
    )

    wait_litert()

    write_state(
        "ready",
        100,
        "Credenciais protegidas, repositório pronto e Gemma 4 ativo.",
        repository=f"{owner}/{repository_name}",
    )

except Exception as error:
    print(f"ERRO: {error}", flush=True)

    write_state(
        "error",
        0,
        "A configuração foi interrompida.",
        error=str(error),
    )

    raise
finally:
    github_pat = ""
    hf_token = ""
PY

chmod +x linux/setup-configure.py

cat > linux/activate-main.sh <<'BASH'
#!/usr/bin/env bash
set -Eeuo pipefail

sleep 2

systemctl --user enable --now engenharia-litert.service

for _ in $(seq 1 90); do
  if curl -fsS \
    --max-time 3 \
    http://127.0.0.1:9379/v1/models \
    >/dev/null 2>&1
  then
    break
  fi

  sleep 2
done

systemctl --user disable --now engenharia-bootstrap.service || true
sleep 1
systemctl --user enable --now engenharia-nim.service
BASH

chmod +x linux/activate-main.sh

info "Preservando a leitura nativa de credenciais do systemd"

python3 <<'PY'
from pathlib import Path
import json

nim_path = Path("nim-server/src/engenharia_server.nim")
nim = nim_path.read_text(encoding="utf-8")

required_fragments = [
    'getEnv("CREDENTIALS_DIRECTORY").strip',
    'credentialsDirectory / "github-pat"',
    'result = readFile(credentialPath).strip',
    'getEnv("ENGINEERING_MACHINE_MAC")',
]

missing = [
    fragment
    for fragment in required_fragments
    if fragment not in nim
]

if missing:
    raise SystemExit(
        "O servidor Nim não contém o suporte esperado a "
        "CREDENTIALS_DIRECTORY/MAC: " + ", ".join(missing)
    )

package_path = Path("package.json")
package = json.loads(package_path.read_text(encoding="utf-8"))
package["version"] = "3.2.0"
package["description"] = (
    "Engenharia com servidores Nim, configuração de credenciais "
    "pela interface, GitHub privado e Gemma 4 E2B"
)
package_path.write_text(
    json.dumps(package, indent=2, ensure_ascii=False) + "\n",
    encoding="utf-8",
)

lock_path = Path("package-lock.json")
lock = json.loads(lock_path.read_text(encoding="utf-8"))
lock["version"] = "3.2.0"

if isinstance(lock.get("packages"), dict) and "" in lock["packages"]:
    lock["packages"][""]["version"] = "3.2.0"

lock_path.write_text(
    json.dumps(lock, indent=2, ensure_ascii=False) + "\n",
    encoding="utf-8",
)
PY

cat > linux/README.md <<'MARKDOWN'
# Instalação Linux com configuração pela interface

O instalador não solicita PAT nem token do Hugging Face no terminal.

Ele inicia `engenharia-bootstrap.service` em:

```text
http://127.0.0.1:3001
```

A interface solicita:

- Personal Access Token do GitHub;
- token do Hugging Face;
- nome do repositório privado, com padrão `engenharia-data`.

O PAT não é persistido no navegador. O servidor de configuração Nim o
protege com `systemd-creds`, e o servidor definitivo valida o SHA-256 do
MAC antes de recuperar a credencial.

Depois da importação do Gemma 4 E2B, a própria interface ativa:

- `engenharia-litert.service`;
- `engenharia-nim.service`.

O bootstrap é então desativado.
MARKDOWN

install -m 0755 \
  "$SCRIPT_PATH" \
  linux/instalar-servidor-local.sh

info "Compilando frontend e servidores Nim"

npm install --registry=https://registry.npmjs.org
npm run build:client
npm run check
npm test

nim check nim-server/src/engenharia_setup.nim
nim check nim-server/src/engenharia_server.nim

nim c \
  -d:release \
  --threads:on \
  --opt:speed \
  --out:dist/EngenhariaSetup \
  nim-server/src/engenharia_setup.nim

nim c \
  -d:release \
  --threads:on \
  --opt:speed \
  --out:dist/EngenhariaServer \
  nim-server/src/engenharia_server.nim

[[ -x dist/EngenhariaSetup ]] ||
  die "EngenhariaSetup não foi compilado."

[[ -x dist/EngenhariaServer ]] ||
  die "EngenhariaServer não foi compilado."

info "Instalando LiteRT-LM sem solicitar credenciais"

if ! command -v uv >/dev/null 2>&1; then
  command -v pacman >/dev/null 2>&1 ||
    die "Instale uv para continuar."

  sudo pacman -S --needed uv
fi

uv tool install --upgrade litert-lm

litert_bin="$(command -v litert-lm || true)"

if [[ -z "$litert_bin" ]] &&
   [[ -x "$HOME/.local/bin/litert-lm" ]]
then
  litert_bin="$HOME/.local/bin/litert-lm"
fi

[[ -x "$litert_bin" ]] ||
  die "litert-lm não foi localizado."

data_root="${XDG_DATA_HOME:-$HOME/.local/share}/engenharia"
config_root="${XDG_CONFIG_HOME:-$HOME/.config}/engenharia"
systemd_root="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"

litert_dir="$data_root/litert-lm"
state_path="$data_root/setup-state.json"
setup_log="$data_root/setup.log"
secret_path="$config_root/github-pat.cred"
main_config="$config_root/config.json"
bootstrap_config="$config_root/setup-config.json"
litert_config="$litert_dir/config.json"

mkdir -p \
  "$data_root" \
  "$config_root" \
  "$systemd_root" \
  "$litert_dir"

chmod 700 "$data_root" "$config_root"

cpu_threads="$(nproc)"
(( cpu_threads > 8 )) && cpu_threads=8
(( cpu_threads < 1 )) && cpu_threads=1

cat > "$litert_config" <<JSON
{
  "default": {
    "backend": "$LITERT_BACKEND",
    "cpu_thread_count": $cpu_threads,
    "cache": "disk",
    "max_num_tokens": 1024,
    "temperature": 0.1
  },
  "models": {
    "$MODEL_ALIAS": {
      "backend": "$LITERT_BACKEND",
      "cpu_thread_count": $cpu_threads,
      "cache": "disk",
      "max_num_tokens": 1024,
      "temperature": 0.1
    }
  }
}
JSON

cat > "$bootstrap_config" <<JSON
{
  "port": $APP_PORT,
  "publicDir": "$PROJECT_DIR/public",
  "projectDir": "$PROJECT_DIR",
  "statePath": "$state_path",
  "logPath": "$setup_log",
  "setupHelper": "$PROJECT_DIR/linux/setup-configure.py",
  "activateHelper": "$PROJECT_DIR/linux/activate-main.sh",
  "machineId": "$machine_hash",
  "machineMac": "$machine_mac",
  "repositoryName": "$REPOSITORY_NAME",
  "mainConfigPath": "$main_config",
  "secretPath": "$secret_path",
  "litertDir": "$litert_dir",
  "litertBin": "$litert_bin",
  "litertUrl": "http://127.0.0.1:$LITERT_PORT",
  "modelRepository": "$MODEL_REPOSITORY",
  "modelFile": "$MODEL_FILE",
  "modelAlias": "$MODEL_ALIAS"
}
JSON

chmod 600 "$bootstrap_config" "$litert_config"

cat > "$state_path" <<JSON
{
  "runtime": "setup-nim",
  "setupRequired": true,
  "phase": "awaiting_credentials",
  "progress": 0,
  "message": "Informe as credenciais na interface.",
  "machineId": "$machine_hash",
  "repositoryName": "$REPOSITORY_NAME"
}
JSON

chmod 600 "$state_path"
: > "$setup_log"
chmod 600 "$setup_log"

info "Criando os serviços systemd"

cat > "$systemd_root/$BOOTSTRAP_SERVICE" <<UNIT
[Unit]
Description=Engenharia — configuração inicial pela interface
After=network-online.target
Wants=network-online.target
Conflicts=$NIM_SERVICE

[Service]
Type=simple
WorkingDirectory=$PROJECT_DIR
ExecStart=$PROJECT_DIR/dist/EngenhariaSetup --config=$bootstrap_config
Restart=on-failure
RestartSec=3
TimeoutStopSec=15

[Install]
WantedBy=default.target
UNIT

cat > "$systemd_root/$LITERT_SERVICE" <<UNIT
[Unit]
Description=Engenharia LiteRT-LM — Gemma 4 E2B
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
Environment=LITERT_LM_DIR=$litert_dir
ExecStart=$litert_bin serve --host 127.0.0.1 --port $LITERT_PORT --config $litert_config
Restart=on-failure
RestartSec=5
TimeoutStopSec=20

[Install]
WantedBy=default.target
UNIT

cat > "$systemd_root/$NIM_SERVICE" <<UNIT
[Unit]
Description=Engenharia Nim Server
After=network-online.target $LITERT_SERVICE
Wants=network-online.target $LITERT_SERVICE
Conflicts=$BOOTSTRAP_SERVICE

[Service]
Type=simple
WorkingDirectory=$PROJECT_DIR
Environment=ENGINEERING_MACHINE_MAC=$machine_mac
LoadCredentialEncrypted=github-pat:$secret_path
ExecStart=$PROJECT_DIR/dist/EngenhariaServer --config=$main_config
Restart=on-failure
RestartSec=5
TimeoutStopSec=20

[Install]
WantedBy=default.target
UNIT

chmod 600 \
  "$systemd_root/$BOOTSTRAP_SERVICE" \
  "$systemd_root/$LITERT_SERVICE" \
  "$systemd_root/$NIM_SERVICE"

info "Criando commit"

git add \
  public/app.js \
  public/index.html \
  src/client/setup-bootstrap.js \
  nim-server/src/engenharia_setup.nim \
  nim-server/src/engenharia_server.nim \
  linux/setup-configure.py \
  linux/activate-main.sh \
  linux/instalar-servidor-local.sh \
  linux/README.md \
  package.json \
  package-lock.json

git status --short
git diff --cached --stat

if ! git diff --cached --quiet; then
  git commit -m \
    "Mover credenciais para a interface de configuração"

  if [[ "$AUTO_PUSH" == "1" ]]; then
    git push origin "HEAD:$BRANCH"
  fi
fi

info "Substituindo o Node pelo bootstrap Nim"

systemctl --user disable --now "$LEGACY_SERVICE" 2>/dev/null || true
systemctl --user disable --now "$NIM_SERVICE" 2>/dev/null || true
systemctl --user disable --now "$LITERT_SERVICE" 2>/dev/null || true

sleep 1

if command -v fuser >/dev/null 2>&1; then
  mapfile -t port_pids < <(
    fuser -n tcp "$APP_PORT" 2>/dev/null |
      tr ' ' '\n' |
      grep -E '^[0-9]+$' ||
      true
  )

  for pid in "${port_pids[@]:-}"; do
    [[ -n "$pid" ]] || continue

    cwd="$(readlink -f "/proc/$pid/cwd" 2>/dev/null || true)"
    cmdline="$(
      tr '\0' ' ' < "/proc/$pid/cmdline" 2>/dev/null ||
      true
    )"

    if [[ "$cwd" == "$PROJECT_DIR" ]] &&
       [[ "$cmdline" == *"node"* ]] &&
       [[ "$cmdline" == *"server.js"* ]]
    then
      warn "Encerrando processo Node legado: PID $pid"
      kill "$pid" 2>/dev/null || true
    else
      die "A porta $APP_PORT está ocupada por outro processo: PID $pid"
    fi
  done
fi

systemctl --user daemon-reload
systemctl --user reset-failed \
  "$BOOTSTRAP_SERVICE" \
  "$NIM_SERVICE" \
  "$LITERT_SERVICE" \
  2>/dev/null || true

systemctl --user enable --now "$BOOTSTRAP_SERVICE"

bootstrap_ready=0
status_response=""

for _ in $(seq 1 30); do
  status_response="$(
    curl -fsS \
      --max-time 4 \
      "http://127.0.0.1:$APP_PORT/api/setup/status" \
      2>/dev/null ||
    true
  )"

  if [[ "$status_response" == *'"runtime":"setup-nim"'* ||
        "$status_response" == *'"runtime": "setup-nim"'* ]]
  then
    bootstrap_ready=1
    break
  fi

  sleep 1
done

if (( bootstrap_ready == 0 )); then
  systemctl --user status "$BOOTSTRAP_SERVICE" --no-pager || true
  journalctl --user \
    -u "$BOOTSTRAP_SERVICE" \
    -n 160 \
    --no-pager || true
  die "O servidor de configuração não assumiu a porta $APP_PORT."
fi

printf '%s\n' "$status_response"

if command -v loginctl >/dev/null 2>&1; then
  sudo loginctl enable-linger "$USER" || true
fi

cat <<MSG

Finalização 3.2.0 concluída.

Commit:
  $(git rev-parse HEAD)

Servidor ativo:
  $BOOTSTRAP_SERVICE

Abra localmente:
  http://127.0.0.1:$APP_PORT

A interface solicitará:
  - Personal Access Token do GitHub;
  - token do Hugging Face;
  - repositório privado, padrão $REPOSITORY_NAME.

Nenhuma credencial da aplicação será solicitada no terminal.

Depois do download, use o botão:
  Ativar EngenhariaNimServer

Backup:
  $backup_dir
MSG
