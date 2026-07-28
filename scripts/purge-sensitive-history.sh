#!/usr/bin/env bash
set -Eeuo pipefail

[[ "${PURGE_HISTORY:-0}" == "1" ]] || {
  cat >&2 <<'MSG'
Este script reescreve o histórico e força o push.

Revise os impactos e execute explicitamente:
  PURGE_HISTORY=1 ./scripts/purge-sensitive-history.sh
MSG
  exit 1
}

command -v git-filter-repo >/dev/null 2>&1 || {
  printf 'Instale no Manjaro: sudo pacman -S git-filter-repo\n' >&2
  exit 1
}

[[ -z "$(git status --porcelain)" ]] || {
  printf 'A árvore Git precisa estar limpa.\n' >&2
  exit 1
}

branch="$(git branch --show-current)"
remote_url="$(git remote get-url origin)"
backup="$HOME/maximus-before-history-purge-$(date +%Y%m%d-%H%M%S).bundle"

git bundle create "$backup" --all
printf 'Backup criado: %s\n' "$backup"

git filter-repo --force --invert-paths \
  --path okf/db.sqlite \
  --path okf/db.sqlite-shm \
  --path okf/db.sqlite-wal \
  --path okf/manifest.json \
  --path-glob 'okf/uploads_raw/**' \
  --path-glob 'okf/knowledge/**' \
  --path-glob '.env*' \
  --path-glob '*.pem' \
  --path-glob '*.key' \
  --path-glob '*.p12' \
  --path-glob '*.pfx'

git remote add origin "$remote_url" 2>/dev/null ||
  git remote set-url origin "$remote_url"

printf '\nHistórico local reescrito. Para publicar:\n'
printf '  git push --force-with-lease origin %q\n' "$branch"
printf '\nO GitHub pode manter caches temporários; revogue credenciais expostas.\n'
