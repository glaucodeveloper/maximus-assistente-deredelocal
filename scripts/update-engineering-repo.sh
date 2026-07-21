#!/usr/bin/env bash
set -euo pipefail

SOURCE_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

for command in git gh npm node tar; do
  command -v "$command" >/dev/null 2>&1 || {
    printf 'Erro: o comando %s não está instalado.\n' "$command" >&2
    exit 1
  }
done

gh auth status >/dev/null

OWNER="${GITHUB_OWNER:-$(gh api user --jq .login)}"
TARGET_REPO="${WEB_REPO:-maximus-assistente-deredelocal}"
VISIBILITY="${REPO_VISIBILITY:-public}"
WEB_URL="https://${OWNER}.github.io/${TARGET_REPO}/"
REMOTE_SSH="git@github.com:${OWNER}/${TARGET_REPO}.git"

case "$VISIBILITY" in
  public|private) ;;
  *) printf 'REPO_VISIBILITY deve ser public ou private.\n' >&2; exit 1 ;;
esac

printf 'Validando e compilando a versão local...\n'
cd "$SOURCE_ROOT"
rm -rf dist
if [[ -f package-lock.json ]]; then
  npm ci --registry=https://registry.npmjs.org
else
  npm install --registry=https://registry.npmjs.org
fi
npm run doctor
npm run validate
npm run build

if ! gh repo view "$OWNER/$TARGET_REPO" >/dev/null 2>&1; then
  printf 'Criando %s/%s...\n' "$OWNER" "$TARGET_REPO"
  gh repo create "$OWNER/$TARGET_REPO" "--$VISIBILITY" \
    --description 'Maximus Engenharia Inteligente — conhecimento técnico transformado em decisão'
fi

WORK_DIR="$(mktemp -d -t maximus-engineering-publish-XXXXXX)"
cleanup() { rm -rf "$WORK_DIR"; }
trap cleanup EXIT
CHECKOUT="$WORK_DIR/repository"

printf 'Criando checkout limpo do repositório remoto...\n'
if git ls-remote --exit-code --heads "$REMOTE_SSH" main >/dev/null 2>&1; then
  git clone --depth 1 --branch main "$REMOTE_SSH" "$CHECKOUT"
else
  git clone "$REMOTE_SSH" "$CHECKOUT"
  cd "$CHECKOUT"
  git switch -c main
fi

# Remove a árvore remota antiga sem tocar no diretório .git.
find "$CHECKOUT" -mindepth 1 -maxdepth 1 ! -name .git -exec rm -rf -- {} +

# Copia a versão local para o checkout limpo. node_modules, dist e .git nunca são enviados.
cd "$SOURCE_ROOT"
tar \
  --exclude='./.git' \
  --exclude='./node_modules' \
  --exclude='./dist' \
  --exclude='./.DS_Store' \
  -cf - . | tar -xf - -C "$CHECKOUT"

cd "$CHECKOUT"
git add -A
if ! git diff --cached --quiet; then
  VERSION="$(node -p "require('./package.json').version")"
  git commit -m "Atualizar Maximus Engenharia Inteligente v${VERSION}"
  git push -u origin main
else
  printf 'Nenhuma alteração para enviar.\n'
fi

printf 'Configurando GitHub Pages para workflow...\n'
if gh api "repos/$OWNER/$TARGET_REPO/pages" >/dev/null 2>&1; then
  gh api --method PUT \
    -H 'Accept: application/vnd.github+json' \
    "repos/$OWNER/$TARGET_REPO/pages" \
    -f build_type=workflow >/dev/null
else
  gh api --method POST \
    -H 'Accept: application/vnd.github+json' \
    "repos/$OWNER/$TARGET_REPO/pages" \
    -f build_type=workflow >/dev/null
fi

gh api --method PATCH \
  -H 'Accept: application/vnd.github+json' \
  "repos/$OWNER/$TARGET_REPO" \
  -f 'description=Maximus Engenharia Inteligente — conhecimento técnico transformado em decisão' \
  -f "homepage=$WEB_URL" >/dev/null

cat <<MSG

Atualização enviada sem mesclar a pasta local com o histórico remoto.

Repositório:
  https://github.com/$OWNER/$TARGET_REPO

Aplicação:
  $WEB_URL

Deploy:
  https://github.com/$OWNER/$TARGET_REPO/actions

Após o deploy, remova versões antigas em DevTools → Application → Storage
→ Clear site data e recarregue com Ctrl+Shift+R.
MSG
