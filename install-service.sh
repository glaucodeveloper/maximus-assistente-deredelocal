#!/usr/bin/env bash
set -Eeuo pipefail

on_error() {
  local exit_code=$?
  printf '\nERRO no instalador, linha %s:\n  %s\n' \
    "${BASH_LINENO[0]:-?}" "${BASH_COMMAND:-?}" >&2
  exit "$exit_code"
}
trap on_error ERR

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

certificate_valid=0
if [[ -s "$CERT_FILE" && -s "$KEY_FILE" ]]; then
  if openssl x509 -in "$CERT_FILE" -noout -checkend 86400 >/dev/null 2>&1 &&
     openssl pkey -in "$KEY_FILE" -noout >/dev/null 2>&1; then
    certificate_valid=1
  fi
fi

if [[ "$certificate_valid" != "1" ]]; then
  printf '==> Gerando certificado TLS local\n'

  host_name="$(hostname -s 2>/dev/null || hostname)"
  host_name="$(printf '%s' "$host_name" | tr -cd 'A-Za-z0-9.-')"
  [[ -n "$host_name" ]] || host_name="engenharia-local"

  local_ip=""
  if command -v ip >/dev/null 2>&1; then
    local_ip="$(
      ip -o -4 addr show scope global up 2>/dev/null |
        awk '{split($4, address, "/"); print address[1]; exit}'
    )"
  fi

  openssl_config="$TLS_DIR/openssl.cnf"
  temp_cert="$TLS_DIR/server.crt.tmp"
  temp_key="$TLS_DIR/server.key.tmp"

  {
    printf '[req]\n'
    printf 'prompt = no\n'
    printf 'distinguished_name = dn\n'
    printf 'x509_extensions = server_ext\n\n'
    printf '[dn]\n'
    printf 'CN = %s\n\n' "$host_name"
    printf '[server_ext]\n'
    printf 'basicConstraints = critical, CA:FALSE\n'
    printf 'keyUsage = critical, digitalSignature, keyEncipherment\n'
    printf 'extendedKeyUsage = serverAuth\n'
    printf 'subjectAltName = @alt_names\n\n'
    printf '[alt_names]\n'
    printf 'DNS.1 = localhost\n'
    printf 'DNS.2 = %s\n' "$host_name"
    printf 'IP.1 = 127.0.0.1\n'
    [[ -n "$local_ip" ]] && printf 'IP.2 = %s\n' "$local_ip"
  } > "$openssl_config"

  rm -f "$temp_cert" "$temp_key"

  openssl req -x509 -newkey rsa:3072 -sha256 -nodes \
    -days 825 \
    -keyout "$temp_key" \
    -out "$temp_cert" \
    -config "$openssl_config" \
    -extensions server_ext

  openssl x509 -in "$temp_cert" -noout -subject -dates
  openssl pkey -in "$temp_key" -noout >/dev/null

  mv -f "$temp_key" "$KEY_FILE"
  mv -f "$temp_cert" "$CERT_FILE"
  chmod 600 "$KEY_FILE" "$CERT_FILE" "$openssl_config"
else
  printf '==> Reutilizando certificado TLS válido\n'
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
MAX_UPLOAD_BYTES=20971520
ENV
chmod 600 "$ENV_FILE"

printf '==> Instalando dependências\n'
cd "$ROOT"
npm install --registry=https://registry.npmjs.org
npm run build:client
npm run check
npm test


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
