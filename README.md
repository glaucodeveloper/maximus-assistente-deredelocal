# OKF Chat Local

Versão 0.2.0.

PWA estático para GitHub Pages com:

- primeira tela contendo apenas o GitHub token;
- opção de salvar o token criptografado no dispositivo;
- login e cadastro de usuários armazenados no repositório;
- namespace separado para arquivos e OKF de cada usuário;
- upload no estilo de um chat com arquivos;
- Gemma 4 E2B executado localmente com LiteRT-LM;
- loop RLM com ferramentas para ler, buscar e criar documentos OKF;
- aprovação explícita antes de qualquer ferramenta gravar no repositório.

## Arquitetura recomendada

Use dois repositórios:

1. **Aplicação pública**: este projeto, publicado no GitHub Pages.
2. **Dados privados**: uma cópia de `repository-seed/`, contendo a base OKF, cadastros e uploads.

Edite `public/app-config.json` antes de publicar:

```json
{
  "repository": {
    "owner": "seu-usuario-ou-organizacao",
    "repo": "okf-chat-data",
    "branch": "main",
    "requirePrivate": true
  }
}
```

A URL do repositório não é secreta. O token é solicitado na primeira tela.
Quando marcado para lembrar, o token é cifrado com AES-GCM por uma chave não exportável salva no IndexedDB. Isso protege contra leitura casual do armazenamento, mas não contra JavaScript malicioso executado na mesma origem.

## Permissão do token

Use um fine-grained personal access token limitado ao repositório de dados com:

```text
Contents: Read and write
```

A escrita é necessária para cadastro, upload e criação de OKF.

## Limite de segurança

A separação entre usuários é **lógica**, por diretórios como:

```text
data/users/<sha256-do-usuario>/account.json
data/users/<sha256-do-usuario>/files/
data/users/<sha256-do-usuario>/okf/
```

Qualquer pessoa que possua um token com acesso direto ao repositório consegue ler, alterar ou apagar os namespaces de todos os usuários. Portanto, esta arquitetura serve para uso pessoal, equipe confiável ou protótipo controlado. Ela não substitui autenticação e autorização de backend.

As senhas são armazenadas como PBKDF2-SHA256 com salt, mas os hashes ainda podem sofrer tentativa offline caso o repositório seja exposto.

## Tipos de upload

O aplicativo armazena arquivos de até 8 MB por padrão. O RLM consegue ler diretamente formatos textuais, incluindo:

- TXT e Markdown;
- JSON, JSONL, YAML, CSV e XML;
- código-fonte e arquivos de configuração.

PDF, imagens e outros binários são armazenados, mas ainda não têm extração de conteúdo nesta versão frontend.

## RLM e ferramentas

O modelo opera por um protocolo restrito de chamadas:

- `list_user_files`
- `read_user_file`
- `search_user_files`
- `list_okf`
- `read_okf`
- `search_okf`
- `create_okf`
- `create_okf_from_file`

Ferramentas de leitura são executadas automaticamente. As duas ferramentas de escrita abrem uma prévia e aguardam aprovação.

## Manjaro Linux

```bash
sudo pacman -S --needed nodejs npm chromium vulkan-tools
vulkaninfo --summary
```

Abra `chrome://gpu` no Chromium e confirme WebGPU.

## Desenvolvimento

```bash
rm -rf node_modules
npm ci --registry=https://registry.npmjs.org
npm run validate
npm run dev
```

Caso o `npm ci` encontre um lockfile antigo com endereço interno, remova `package-lock.json` e execute:

```bash
npm install --registry=https://registry.npmjs.org
```

## Preparar o repositório de dados

```bash
mkdir okf-chat-data
cp -R repository-seed/. okf-chat-data/
cd okf-chat-data
git init
git add .
git commit -m "Inicializar base OKF"
```

Crie um repositório privado no GitHub e envie esse conteúdo. Depois configure seu nome e repositório em `public/app-config.json` no projeto da aplicação.

## Publicar no GitHub Pages

1. Envie a aplicação ao branch `main`.
2. Em **Settings → Pages**, selecione **GitHub Actions**.
3. O workflow compila o Vite e publica `dist`.
4. Abra o Pages no Chromium, informe o token, entre ou cadastre-se e baixe o modelo.

## Modelo local

O arquivo `gemma-4-E2B-it-web.litertlm` tem aproximadamente 2 GB e é salvo no OPFS do navegador. Limpar os dados do site remove o token salvo, o shell offline e o modelo.
