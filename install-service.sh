#!/usr/bin/env bash
set -Eeuo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONFIG_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/engenharia"
SYSTEMD_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
ENV_FILE="$CONFIG_DIR/engenharia.env"
TLS_DIR="$CONFIG_DIR/tls"
CERT_FILE="$TLS_DIR/server.crt"
KEY_FILE="$TLS_DIR/server.key"
SERVICE_TARGET="$SYSTEMD_DIR/engenharia.service"

PORT="${ENGINEERING_PORT:-3001}"
FTP_PORT="${ENGINEERING_FTP_PORT:-2122}"
FTP_ENABLED="${FTP_ENABLED:-1}"
PREPARE_MODEL="${PREPARE_MODEL:-1}"
ISSUE_INITIAL_TOKEN="${ISSUE_INITIAL_TOKEN:-1}"

for command in node npm openssl systemctl; do
  command -v "$command" >/dev/null 2>&1 || {
    printf 'Erro: comando ausente: %s\n' "$command" >&2
    exit 1
  }
done

node_major="$(node -p 'Number(process.versions.node.split(".")[0])')"
if ((node_major < 22)); then
  printf 'Erro: Node.js 22 ou superior é necessário; atual: %s\n' "$(node --version)" >&2
  exit 1
fi

mkdir -p "$CONFIG_DIR" "$TLS_DIR" "$SYSTEMD_DIR"
chmod 700 "$CONFIG_DIR" "$TLS_DIR"

if [[ ! -s "$CERT_FILE" || ! -s "$KEY_FILE" ]]; then
  printf '==> Gerando certificado TLS local\n'
  host_name="$(hostname)"
  local_ip="$(hostname -I 2>/dev/null | awk '{print $1}')"
  san="DNS:$host_name,DNS:localhost,IP:127.0.0.1"
  [[ -n "$local_ip" ]] && san="$san,IP:$local_ip"

  openssl req -x509 -newkey rsa:3072 -sha256 -nodes \
    -days 825 \
    -keyout "$KEY_FILE" \
    -out "$CERT_FILE" \
    -subj "/CN=$host_name" \
    -addext "subjectAltName=$san"
  chmod 600 "$KEY_FILE" "$CERT_FILE"
fi

cat >"$ENV_FILE" <<ENV
NODE_ENV=production
PORT=$PORT
FTP_PORT=$FTP_PORT
FTP_ENABLED=$FTP_ENABLED
TLS_CERT_PATH=$CERT_FILE
TLS_KEY_PATH=$KEY_FILE
FTP_TLS_CERT_PATH=$CERT_FILE
FTP_TLS_KEY_PATH=$KEY_FILE
ALLOW_INSECURE_HTTP=0
MODEL_ID=onnx-community/gemma-3-1b-it-ONNX
MODEL_FALLBACK_ID=onnx-community/Qwen2.5-0.5B-Instruct
MODEL_DTYPE=q4
MODEL_DEVICE=
MODEL_CACHE_DIR=$ROOT/.cache/transformers
MODEL_MAX_NEW_TOKENS=768
MODEL_MAX_INPUT_CHARS=24000
MODEL_PRELOAD=1
MAX_UPLOAD_BYTES=20971520
ENV
chmod 600 "$ENV_FILE"

printf '==> Instalando dependências\n'
cd "$ROOT"
npm install --registry=https://registry.npmjs.org
npm run check
npm test

if [[ "$PREPARE_MODEL" == "1" ]]; then
  printf '==> Preparando o modelo local\n'
  set -a
  # shellcheck disable=SC1090
  source "$ENV_FILE"
  set +a
  npm run model:prepare
fi

sed \
  -e "s|__PROJECT_DIR__|$ROOT|g" \
  -e "s|__ENV_FILE__|$ENV_FILE|g" \
  "$ROOT/engenharia.service" >"$SERVICE_TARGET"

systemctl --user daemon-reload
systemctl --user enable --now engenharia.service

if command -v loginctl >/dev/null 2>&1; then
  loginctl enable-linger "$(id -un)" >/dev/null 2>&1 || true
fi

printf '\nServiço instalado.\n'
printf 'HTTPS: https://%s:%s\n' "$(hostname)" "$PORT"
if [[ "$FTP_ENABLED" == "1" ]]; then
  printf 'FTPS:  ftps://%s:%s\n' "$(hostname)" "$FTP_PORT"
fi
printf 'Certificado: %s\n' "$CERT_FILE"
printf 'Status:\n'
systemctl --user --no-pager --full status engenharia.service || true

if [[ "$ISSUE_INITIAL_TOKEN" == "1" ]]; then
  printf '\n==> Token inicial de pareamento\n'
  npm run pairing:issue -- --hours 24 --note "Instalação inicial"
fi
