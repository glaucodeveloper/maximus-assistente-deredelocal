#!/usr/bin/env bash
set -Eeuo pipefail

# Resolve o próprio arquivo antes de mudar de diretório.
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
NIM_SERVICE="engenharia-nim.service"
LITERT_SERVICE="engenharia-litert.service"

info() { printf '\n==> %s\n' "$*"; }
warn() { printf '\nAVISO: %s\n' "$*" >&2; }
die() { printf '\nERRO: %s\n' "$*" >&2; exit 1; }

cleanup_secrets() {
  unset GITHUB_PAT HF_TOKEN || true
}
trap cleanup_secrets EXIT

for command_name in \
  git node npm python3 curl nim systemctl sha256sum readlink
do
  command -v "$command_name" >/dev/null 2>&1 ||
    die "Comando ausente: $command_name"
done

[[ -d "$PROJECT_DIR/.git" ]] ||
  die "$PROJECT_DIR não é um checkout Git."

cd "$PROJECT_DIR"

version="$(node -p 'require("./package.json").version')"

case "$version" in
  3.0.2|3.1.0) ;;
  *)
    die "Versão esperada 3.0.2/3.1.0; encontrada: $version"
    ;;
esac

if [[ -n "$(git status --porcelain)" ]]; then
  git status --short
  die "A árvore possui alterações. Faça commit ou stash antes."
fi

case "$(uname -m)" in
  x86_64|aarch64) ;;
  *)
    die "Arquitetura Linux não suportada pelo instalador: $(uname -m)"
    ;;
esac

if [[ ! -r /etc/machine-id ]]; then
  die "/etc/machine-id não está disponível."
fi

timestamp="$(date +%Y%m%d-%H%M%S)"
backup_dir="${XDG_DATA_HOME:-$HOME/.local/share}/maximus-patches/linux-nim-litert-$timestamp"
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

if [[ -z "$machine_interface" ]]; then
  for interface_path in /sys/class/net/*; do
    interface_name="$(basename "$interface_path")"
    [[ "$interface_name" == "lo" ]] && continue
    machine_interface="$interface_name"
    break
  done
fi

[[ -n "$machine_interface" ]] ||
  die "Nenhuma interface de rede foi localizada."

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
printf 'Identificador da máquina: %s\n' "$machine_hash"

info "Atualizando o servidor Nim para credencial systemd e MAC explícito"

mkdir -p linux

install -m 0755 \
  "$SCRIPT_PATH" \
  linux/instalar-servidor-local.sh

python3 <<'PY'
from pathlib import Path
import json

nim_path = Path("nim-server/src/engenharia_server.nim")
nim = nim_path.read_text(encoding="utf-8")

old_primary = '''proc primaryMac(): string =
  when defined(windows):
'''

new_primary = '''proc primaryMac(): string =
  let configured =
    normalizeMac(getEnv("ENGINEERING_MACHINE_MAC"))

  if configured.len == 12:
    return configured

  when defined(windows):
'''

if "ENGINEERING_MACHINE_MAC" not in nim:
    if old_primary not in nim:
        raise SystemExit("primaryMac não foi localizado.")
    nim = nim.replace(old_primary, new_primary, 1)

old_linux_pat = '''  else:
    result = getEnv("ENGINEERING_GITHUB_PAT").strip
  if result.len == 0:
'''

new_linux_pat = '''  else:
    let credentialsDirectory =
      getEnv("CREDENTIALS_DIRECTORY").strip

    if credentialsDirectory.len > 0:
      let credentialPath =
        credentialsDirectory / "github-pat"

      if fileExists(credentialPath):
        result = readFile(credentialPath).strip

    if result.len == 0:
      result = getEnv("ENGINEERING_GITHUB_PAT").strip

  if result.len == 0:
'''

if "credentialsDirectory" not in nim:
    if old_linux_pat not in nim:
        raise SystemExit("Leitura Linux do PAT não foi localizada.")
    nim = nim.replace(old_linux_pat, new_linux_pat, 1)

nim_path.write_text(nim, encoding="utf-8")

package_path = Path("package.json")
package = json.loads(package_path.read_text(encoding="utf-8"))
package["version"] = "3.1.0"
package_path.write_text(
    json.dumps(package, indent=2, ensure_ascii=False) + "\n",
    encoding="utf-8",
)

lock_path = Path("package-lock.json")
lock = json.loads(lock_path.read_text(encoding="utf-8"))
lock["version"] = "3.1.0"

if isinstance(lock.get("packages"), dict) and "" in lock["packages"]:
    lock["packages"][""]["version"] = "3.1.0"

lock_path.write_text(
    json.dumps(lock, indent=2, ensure_ascii=False) + "\n",
    encoding="utf-8",
)
PY

cat > linux/README.md <<'MARKDOWN'
# Instalação Linux

Execute no Manjaro/Arch:

```bash
PROJECT_DIR="$HOME/dev/engenharia" \
AUTO_PUSH=1 \
./linux/instalar-servidor-local.sh
```

O instalador:

- compila o servidor Nim;
- cria ou reutiliza `engenharia-data`;
- protege o PAT com `systemd-creds`, quando disponível;
- associa a configuração ao MAC selecionado;
- instala LiteRT-LM;
- importa Gemma 4 E2B;
- registra os serviços de usuário:
  - `engenharia-litert.service`;
  - `engenharia-nim.service`;
- desativa o servidor Node legado.

O servidor web definitivo fica em:

```text
http://127.0.0.1:3001
```
MARKDOWN

info "Validando e compilando o projeto atualizado"

npm install --registry=https://registry.npmjs.org
npm run build:client
npm run check
npm test

nim check nim-server/src/engenharia_server.nim

mkdir -p dist

nim c \
  -d:release \
  --threads:on \
  --opt:speed \
  --out:dist/EngenhariaServer \
  nim-server/src/engenharia_server.nim

[[ -x dist/EngenhariaServer ]] ||
  die "O executável Nim não foi produzido."

info "Registrando a atualização 3.1.0"

git add \
  nim-server/src/engenharia_server.nim \
  linux/README.md \
  linux/instalar-servidor-local.sh \
  package.json \
  package-lock.json

git status --short
git diff --cached --stat

if ! git diff --cached --quiet; then
  git commit -m \
    "Adicionar instalação Linux do servidor Nim e Gemma 4"

  if [[ "$AUTO_PUSH" == "1" ]]; then
    git push origin "HEAD:$BRANCH"
  fi
fi

info "Verificando dependências Linux"

missing_packages=()

command -v uv >/dev/null 2>&1 ||
  missing_packages+=("uv")

command -v openssl >/dev/null 2>&1 ||
  missing_packages+=("openssl")

if (( ${#missing_packages[@]} > 0 )); then
  command -v pacman >/dev/null 2>&1 ||
    die "Instale manualmente: ${missing_packages[*]}"

  sudo pacman -S --needed "${missing_packages[@]}"
fi

info "Verificando espaço para o modelo"

data_root="${XDG_DATA_HOME:-$HOME/.local/share}/engenharia"
litert_dir="$data_root/litert-lm"
model_path="$litert_dir/models/$MODEL_ALIAS/model.litertlm"

mkdir -p "$litert_dir"

available_kb="$(
  df -Pk "$data_root" |
    awk 'NR==2 {print $4}'
)"

minimum_kb=$((7 * 1024 * 1024))

if (( available_kb < minimum_kb )); then
  die "São necessários ao menos 7 GiB livres para download, importação e cache."
fi

info "Solicitando credenciais"

read -r -s -p \
  "Personal Access Token do GitHub (repo/contents): " \
  GITHUB_PAT
printf '\n'

[[ -n "$GITHUB_PAT" ]] ||
  die "O PAT do GitHub é obrigatório."

read -r -s -p \
  "Token do Hugging Face, ou Enter para repositório público: " \
  HF_TOKEN
printf '\n'

export GITHUB_PAT REPOSITORY_NAME machine_hash

mapfile -t github_result < <(
  python3 <<'PY'
import base64
import json
import os
import sys
import urllib.error
import urllib.request
from datetime import datetime, timezone

token = os.environ["GITHUB_PAT"]
repo_name = os.environ["REPOSITORY_NAME"]
machine_hash = os.environ["machine_hash"]

headers = {
    "Accept": "application/vnd.github+json",
    "Authorization": f"Bearer {token}",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "engenharia-linux-installer/3.1",
}

def request(method, url, payload=None):
    data = None

    if payload is not None:
        data = json.dumps(payload).encode("utf-8")

    req = urllib.request.Request(
        url,
        data=data,
        headers=headers,
        method=method,
    )

    try:
        with urllib.request.urlopen(req, timeout=60) as response:
            raw = response.read().decode("utf-8")
            return response.status, json.loads(raw) if raw else {}
    except urllib.error.HTTPError as error:
        raw = error.read().decode("utf-8", errors="replace")

        try:
            details = json.loads(raw)
        except json.JSONDecodeError:
            details = {"message": raw}

        return error.code, details

status, user = request("GET", "https://api.github.com/user")

if status != 200:
    raise SystemExit(
        f"GitHub recusou o PAT: HTTP {status}: {user.get('message', user)}"
    )

owner = user["login"]
display_name = user.get("name") or owner
repo_url = f"https://api.github.com/repos/{owner}/{repo_name}"

status, repo = request("GET", repo_url)

if status == 404:
    status, repo = request(
        "POST",
        "https://api.github.com/user/repos",
        {
            "name": repo_name,
            "description": "Dados privados da aplicação Engenharia",
            "private": True,
            "auto_init": True,
        },
    )

    if status != 201:
        raise SystemExit(
            "Não foi possível criar o repositório privado: "
            f"HTTP {status}: {repo.get('message', repo)}"
        )
elif status != 200:
    raise SystemExit(
        f"Falha ao consultar o repositório: HTTP {status}: "
        f"{repo.get('message', repo)}"
    )

if not repo.get("private", False):
    raise SystemExit(
        f"O repositório {owner}/{repo_name} existe, mas não é privado."
    )

def put_file(path, content, message):
    encoded_path = "/".join(
        urllib.parse.quote(part, safe="")
        for part in path.split("/")
    )
    url = f"{repo_url}/contents/{encoded_path}"

    current_status, current = request("GET", url)
    body = {
        "message": message,
        "content": base64.b64encode(
            content.encode("utf-8")
        ).decode("ascii"),
        "branch": "main",
    }

    if current_status == 200:
        body["sha"] = current["sha"]
    elif current_status != 404:
        raise SystemExit(
            f"Falha ao consultar {path}: HTTP {current_status}: "
            f"{current.get('message', current)}"
        )

    saved_status, saved = request("PUT", url, body)

    if saved_status not in (200, 201):
        raise SystemExit(
            f"Falha ao gravar {path}: HTTP {saved_status}: "
            f"{saved.get('message', saved)}"
        )

put_file(
    "documents/README.md",
    "# Engenharia Data\n\n"
    "Repositório privado utilizado pelo servidor local Nim.\n",
    "Inicializar documentos de Engenharia",
)

put_file(
    "state/tasks.json",
    "[]\n",
    "Inicializar atividades de Engenharia",
)

machine_record = json.dumps(
    {
        "machineId": machine_hash,
        "macHash": machine_hash,
        "host": os.uname().nodename,
        "registeredAt": datetime.now(timezone.utc).isoformat(),
        "application": "Engenharia",
        "rawMacStored": False,
    },
    ensure_ascii=False,
    indent=2,
) + "\n"

put_file(
    f"machines/{machine_hash}.json",
    machine_record,
    "Registrar servidor Linux de Engenharia",
)

print(owner)
print(display_name)
print(f"{owner}/{repo_name}")
PY
)

unset GITHUB_PAT

(( ${#github_result[@]} >= 3 )) ||
  die "A configuração GitHub não retornou os dados esperados."

github_owner="${github_result[0]}"
display_name="${github_result[1]}"
github_repository="${github_result[2]}"

printf 'Repositório: %s\n' "$github_repository"

info "Instalando a CLI LiteRT-LM"

uv tool install --upgrade litert-lm

litert_bin="$(command -v litert-lm || true)"

if [[ -z "$litert_bin" ]] &&
   [[ -x "$HOME/.local/bin/litert-lm" ]]
then
  litert_bin="$HOME/.local/bin/litert-lm"
fi

[[ -x "$litert_bin" ]] ||
  die "litert-lm não foi localizado após a instalação."

cpu_threads="$(nproc)"
(( cpu_threads > 8 )) && cpu_threads=8
(( cpu_threads < 1 )) && cpu_threads=1

cat > "$litert_dir/config.json" <<JSON
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

if [[ ! -s "$model_path" ]] ||
   (( $(stat -c '%s' "$model_path" 2>/dev/null || echo 0) < 1000000000 ))
then
  info "Baixando e importando Gemma 4 E2B"

  if [[ -n "$HF_TOKEN" ]]; then
    HF_TOKEN="$HF_TOKEN" \
    LITERT_LM_DIR="$litert_dir" \
      "$litert_bin" import \
        --from-huggingface-repo="$MODEL_REPOSITORY" \
        "$MODEL_FILE" \
        "$MODEL_ALIAS"
  else
    LITERT_LM_DIR="$litert_dir" \
      "$litert_bin" import \
        --from-huggingface-repo="$MODEL_REPOSITORY" \
        "$MODEL_FILE" \
        "$MODEL_ALIAS"
  fi
else
  info "Gemma 4 E2B já está importado"
fi

unset HF_TOKEN

[[ -s "$model_path" ]] ||
  die "O arquivo importado do Gemma 4 não foi localizado."

info "Criando a configuração local do servidor Nim"

config_root="${XDG_CONFIG_HOME:-$HOME/.config}/engenharia"
systemd_root="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
credential_root="${XDG_CONFIG_HOME:-$HOME/.config}/credstore.encrypted"
app_config="$config_root/config.json"
fallback_env="$config_root/nim.env"
credential_file="$credential_root/engenharia-github-pat.cred"

mkdir -p "$config_root" "$systemd_root" "$credential_root"
chmod 700 "$config_root" "$credential_root"

cat > "$app_config" <<JSON
{
  "port": $APP_PORT,
  "publicDir": "$PROJECT_DIR/public",
  "secretPath": "",
  "githubOwner": "$github_owner",
  "githubRepo": "$REPOSITORY_NAME",
  "githubBranch": "main",
  "macHash": "$machine_hash",
  "litertBaseUrl": "http://127.0.0.1:$LITERT_PORT",
  "modelAlias": "$MODEL_ALIAS",
  "displayName": $(python3 -c 'import json,sys; print(json.dumps(sys.argv[1], ensure_ascii=False))' "$display_name")
}
JSON

chmod 600 "$app_config"

credential_directive=""
credential_mode="environment-file"

if command -v systemd-creds >/dev/null 2>&1; then
  read -r -s -p \
    "Repita o PAT do GitHub para criptografá-lo no systemd: " \
    GITHUB_PAT
  printf '\n'

  if [[ -n "$GITHUB_PAT" ]] &&
     printf '%s' "$GITHUB_PAT" |
       systemd-creds encrypt \
         --user \
         --name=github-pat \
         - \
         "$credential_file" \
         >/dev/null
  then
    chmod 600 "$credential_file"
    credential_directive="LoadCredentialEncrypted=github-pat:$credential_file"
    credential_mode="systemd-creds"
    rm -f "$fallback_env"
  else
    warn "systemd-creds não pôde ser usado; aplicando arquivo 0600."
  fi
fi

if [[ "$credential_mode" == "environment-file" ]]; then
  if [[ -z "${GITHUB_PAT:-}" ]]; then
    read -r -s -p \
      "Repita o PAT do GitHub para o serviço local: " \
      GITHUB_PAT
    printf '\n'
  fi

  [[ -n "$GITHUB_PAT" ]] ||
    die "O PAT é obrigatório para iniciar o servidor Nim."

  {
    printf 'ENGINEERING_GITHUB_PAT=%s\n' "$GITHUB_PAT"
    printf 'ENGINEERING_MACHINE_MAC=%s\n' "$machine_mac"
  } > "$fallback_env"

  chmod 600 "$fallback_env"
fi

unset GITHUB_PAT

info "Criando serviços systemd de usuário"

cat > "$systemd_root/$LITERT_SERVICE" <<UNIT
[Unit]
Description=Engenharia LiteRT-LM — Gemma 4 E2B
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
Environment=LITERT_LM_DIR=$litert_dir
ExecStart=$litert_bin serve --host 127.0.0.1 --port $LITERT_PORT --config $litert_dir/config.json
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

[Service]
Type=simple
WorkingDirectory=$PROJECT_DIR
Environment=ENGINEERING_MACHINE_MAC=$machine_mac
EnvironmentFile=-$fallback_env
$credential_directive
ExecStart=$PROJECT_DIR/dist/EngenhariaServer --config=$app_config
Restart=on-failure
RestartSec=5
TimeoutStopSec=20

[Install]
WantedBy=default.target
UNIT

chmod 600 \
  "$systemd_root/$LITERT_SERVICE" \
  "$systemd_root/$NIM_SERVICE"

info "Desativando o servidor Node legado"

systemctl --user disable --now "$LEGACY_SERVICE" 2>/dev/null || true

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

    process_cwd="$(
      readlink -f "/proc/$pid/cwd" 2>/dev/null ||
      true
    )"

    process_command="$(
      tr '\0' ' ' < "/proc/$pid/cmdline" 2>/dev/null ||
      true
    )"

    if [[ "$process_cwd" == "$PROJECT_DIR" ]] &&
       [[ "$process_command" == *"node"* ]] &&
       [[ "$process_command" == *"server.js"* ]]
    then
      warn "Encerrando processo Node legado: PID $pid"
      kill "$pid" 2>/dev/null || true
    else
      die "A porta $APP_PORT está ocupada por outro processo: PID $pid"
    fi
  done
fi

info "Ativando os serviços definitivos"

systemctl --user daemon-reload
systemctl --user reset-failed "$LITERT_SERVICE" "$NIM_SERVICE" || true
systemctl --user enable --now "$LITERT_SERVICE"

litert_ready=0

for _ in $(seq 1 60); do
  if curl -fsS \
    --max-time 3 \
    "http://127.0.0.1:$LITERT_PORT/v1/models" \
    >/dev/null 2>&1
  then
    litert_ready=1
    break
  fi

  sleep 2
done

if (( litert_ready == 0 )); then
  systemctl --user status "$LITERT_SERVICE" --no-pager || true
  journalctl --user \
    -u "$LITERT_SERVICE" \
    -n 160 \
    --no-pager || true
  die "LiteRT-LM não ficou pronto."
fi

systemctl --user enable --now "$NIM_SERVICE"

nim_ready=0
health_response=""

for _ in $(seq 1 45); do
  health_response="$(
    curl -fsS \
      --max-time 5 \
      "http://127.0.0.1:$APP_PORT/api/health" \
      2>/dev/null ||
    true
  )"

  if [[ "$health_response" == *'"runtime":"nim"'* ||
        "$health_response" == *'"runtime": "nim"'* ]]
  then
    nim_ready=1
    break
  fi

  sleep 2
done

if (( nim_ready == 0 )); then
  systemctl --user status "$NIM_SERVICE" --no-pager || true
  journalctl --user \
    -u "$NIM_SERVICE" \
    -n 160 \
    --no-pager || true
  die "EngenhariaNimServer não assumiu a porta $APP_PORT."
fi

printf '%s\n' "$health_response"

if command -v loginctl >/dev/null 2>&1; then
  sudo loginctl enable-linger "$USER" || true
fi

lan_address="$(
  hostname -I 2>/dev/null |
    awk '{print $1}'
)"

cat <<MSG

Instalação Linux 3.1.0 concluída.

Commit:
  $(git rev-parse HEAD)

Serviços ativos:
  $LITERT_SERVICE
  $NIM_SERVICE

Credencial GitHub:
  $credential_mode + verificação do MAC

Repositório:
  $github_repository

Modelo:
  Gemma 4 E2B / LiteRT-LM
  $model_path

Acesso local:
  http://127.0.0.1:$APP_PORT

Acesso pela rede:
  http://${lan_address:-IP-DESTA-MAQUINA}:$APP_PORT

Backup:
  $backup_dir

Use HTTP nesta instalação Linux. O serviço Node HTTPS legado foi
desativado e a porta agora pertence ao servidor Nim.
MSG
