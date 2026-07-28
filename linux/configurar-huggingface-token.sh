#!/usr/bin/env bash
set -Eeuo pipefail

CREDENTIAL_NAME="huggingface-token"
CREDENTIAL_ROOT="${XDG_CONFIG_HOME:-$HOME/.config}/credstore.encrypted"
CREDENTIAL_PATH="$CREDENTIAL_ROOT/engenharia-huggingface-token.cred"

command -v systemd-creds >/dev/null 2>&1 || {
  echo "ERRO: systemd-creds não está instalado." >&2
  exit 1
}

mkdir -p "$CREDENTIAL_ROOT"
chmod 700 "$CREDENTIAL_ROOT"

HF_TOKEN="${HF_TOKEN:-}"

if [[ -z "$HF_TOKEN" ]]; then
  read -r -s -p "Token do Hugging Face (hf_...): " HF_TOKEN
  printf '\n'
fi

[[ "$HF_TOKEN" == hf_* ]] || {
  echo "ERRO: o token deve começar com hf_." >&2
  exit 1
}

temporary="$CREDENTIAL_ROOT/.hf-token-$$.cred"
trap 'unset HF_TOKEN; rm -f "$temporary"' EXIT

printf '%s' "$HF_TOKEN" |
  systemd-creds encrypt \
    --user \
    --name="$CREDENTIAL_NAME" \
    - \
    "$temporary" \
    >/dev/null

chmod 600 "$temporary"
mv -f "$temporary" "$CREDENTIAL_PATH"
unset HF_TOKEN

echo "Token do Hugging Face protegido em:"
echo "  $CREDENTIAL_PATH"
