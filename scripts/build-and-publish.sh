#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

for command in git gh npm node; do
  command -v "$command" >/dev/null 2>&1 || {
    printf 'Erro: o comando %s não está instalado.\n' "$command" >&2
    exit 1
  }
done

gh auth status >/dev/null

OWNER="${GITHUB_OWNER:-$(gh api user --jq .login)}"
WEB_REPO="${WEB_REPO:-maximus-engenharia-inteligente}"
DATA_REPO="${DATA_REPO:-maximus-engenharia-inteligente-data}"
OLD_WEB_REPO="${OLD_WEB_REPO:-okf-chat-web}"
OLD_DATA_REPO="${OLD_DATA_REPO:-okf-chat-data}"
RENAME_EXISTING="${RENAME_EXISTING:-1}"
WEB_URL="https://${OWNER}.github.io/${WEB_REPO}/"

repo_exists() {
  gh repo view "$OWNER/$1" >/dev/null 2>&1
}

rename_repo_if_needed() {
  local old_name="$1"
  local new_name="$2"
  if repo_exists "$new_name"; then
    return 0
  fi
  if [[ "$RENAME_EXISTING" == "1" ]] && repo_exists "$old_name"; then
    printf 'Renomeando %s/%s para %s...\n' "$OWNER" "$old_name" "$new_name"
    gh api --method PATCH \
      -H 'Accept: application/vnd.github+json' \
      -H 'X-GitHub-Api-Version: 2026-03-10' \
      "repos/$OWNER/$old_name" \
      -f "name=$new_name" >/dev/null
  fi
}

rename_repo_if_needed "$OLD_WEB_REPO" "$WEB_REPO"
rename_repo_if_needed "$OLD_DATA_REPO" "$DATA_REPO"

if ! repo_exists "$DATA_REPO"; then
  printf 'Criando repositório privado de dados %s/%s...\n' "$OWNER" "$DATA_REPO"
  gh repo create "$OWNER/$DATA_REPO" --private --description 'Base privada da Maximus Engenharia Inteligente'

  tmp_data="$(mktemp -d)"
  trap 'rm -rf "${tmp_data:-}"' EXIT
  cp -R repository-seed/. "$tmp_data/"
  (
    cd "$tmp_data"
    git init -b main
    git add .
    git commit -m 'Inicializar base privada Maximus'
    git remote add origin "git@github.com:$OWNER/$DATA_REPO.git"
    git push -u origin main
  )
else
  printf 'Atualizando o fluxo de confirmação no repositório de dados...\n'
  tmp_data="$(mktemp -d)"
  trap 'rm -rf "${tmp_data:-}"' EXIT
  git clone --depth 1 "git@github.com:$OWNER/$DATA_REPO.git" "$tmp_data"
  mkdir -p "$tmp_data/.github/workflows" "$tmp_data/data/verification-requests"
  cp repository-seed/.github/workflows/confirm-email.yml "$tmp_data/.github/workflows/confirm-email.yml"
  touch "$tmp_data/data/verification-requests/.gitkeep"
  (
    cd "$tmp_data"
    if ! git rev-parse --verify HEAD >/dev/null 2>&1; then
      git switch -C main
    fi
    git add .github/workflows/confirm-email.yml data/verification-requests/.gitkeep
    if ! git diff --cached --quiet; then
      git commit -m 'Adicionar confirmação de acesso Maximus por e-mail'
      git push
    fi
  )
fi

node - "$OWNER" "$DATA_REPO" "$WEB_URL" <<'NODE'
import fs from 'node:fs';
const [owner, repo, webUrl] = process.argv.slice(2);
const path = 'public/app-config.json';
const config = JSON.parse(fs.readFileSync(path, 'utf8'));
config.repository.owner = owner;
config.repository.repo = repo;
config.confirmation.webUrl = webUrl;
fs.writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`);
NODE

printf 'Instalando dependências pelo registry público...\n'
npm ci --registry=https://registry.npmjs.org
npm run doctor
npm run validate
npm run build

if ! repo_exists "$WEB_REPO"; then
  printf 'Criando repositório público %s/%s...\n' "$OWNER" "$WEB_REPO"
  gh repo create "$OWNER/$WEB_REPO" --public \
    --description 'Inteligência técnica local da Maximus Empreendimentos'
fi

gh api --method PATCH \
  -H 'Accept: application/vnd.github+json' \
  -H 'X-GitHub-Api-Version: 2026-03-10' \
  "repos/$OWNER/$WEB_REPO" \
  -f 'description=Maximus Engenharia Inteligente — conhecimento técnico transformado em decisão' \
  -f "homepage=$WEB_URL" >/dev/null

gh api --method PATCH \
  -H 'Accept: application/vnd.github+json' \
  -H 'X-GitHub-Api-Version: 2026-03-10' \
  "repos/$OWNER/$DATA_REPO" \
  -f 'description=Base privada de artefatos e conhecimento da Maximus Engenharia Inteligente' >/dev/null

if [[ ! -d .git ]]; then
  git init -b main
else
  git branch -M main
fi

git remote remove origin 2>/dev/null || true
git remote add origin "git@github.com:$OWNER/$WEB_REPO.git"

git add -A
if ! git diff --cached --quiet; then
  git commit -m 'Publicar Maximus Engenharia Inteligente'
fi

if git ls-remote --exit-code --heads origin main >/dev/null 2>&1; then
  git pull --rebase origin main
fi
git push -u origin main

printf 'Configurando GitHub Pages para GitHub Actions...\n'
if gh api "repos/$OWNER/$WEB_REPO/pages" >/dev/null 2>&1; then
  gh api --method PUT \
    -H 'Accept: application/vnd.github+json' \
    -H 'X-GitHub-Api-Version: 2026-03-10' \
    "repos/$OWNER/$WEB_REPO/pages" \
    -f build_type=workflow >/dev/null
else
  gh api --method POST \
    -H 'Accept: application/vnd.github+json' \
    -H 'X-GitHub-Api-Version: 2026-03-10' \
    "repos/$OWNER/$WEB_REPO/pages" \
    -f build_type=workflow >/dev/null
fi

cat <<MSG

Publicação enviada.

Repositório web:
  https://github.com/$OWNER/$WEB_REPO

Aplicação:
  $WEB_URL

Repositório privado de dados:
  https://github.com/$OWNER/$DATA_REPO

Confirmação por e-mail:
  Configure no repositório de dados os secrets SMTP_HOST, SMTP_PORT,
  SMTP_USERNAME, SMTP_PASSWORD e SMTP_FROM.

Instalação do PWA:
  Abra a aplicação no Chromium e clique em “Instalar aplicativo”.
  Se a janela não aparecer, abra o menu ⋮ e escolha
  “Instalar Maximus Intelligence”.
MSG
