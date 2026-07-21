# Maximus Engenharia Inteligente

**Conhecimento técnico transformado em decisão.**

PWA de inteligência técnica local para a Maximus Empreendimentos. O Gemma 4 E2B é executado no dispositivo com LiteRT-LM, enquanto artefatos, usuários e documentos OKF ficam em um repositório privado no GitHub.

## Repositórios padrão

- frontend público: `maximus-engenharia-inteligente`;
- base privada: `maximus-engenharia-inteligente-data`;
- endereço do Pages: `https://SEU_USUARIO.github.io/maximus-engenharia-inteligente/`.

O script de publicação pode renomear automaticamente os repositórios antigos `okf-chat-web` e `okf-chat-data`.

## Funcionalidades

- chave GitHub protegida no dispositivo;
- login e cadastro por identificador Maximus;
- identificador único no formato `MAX-USR-XXXXXXXXXXXX`;
- confirmação de e-mail emitida por GitHub Actions e SMTP;
- áreas individuais para artefatos e conhecimento estruturado;
- upload de arquivos;
- chat técnico fundamentado na base autorizada;
- ferramentas RLM controladas;
- aprovação antes de qualquer gravação;
- modelo Gemma 4 armazenado no OPFS;
- instalação como PWA.

## Instalar no dispositivo

Depois que a aplicação estiver aberta e pronta:

1. clique em **Instalar aplicativo** na área lateral;
2. confirme a instalação apresentada pelo navegador;
3. caso a janela não apareça, abra o menu **⋮** do Chromium;
4. escolha **Instalar Maximus Intelligence**.

O botão e essa instrução também aparecem dentro da interface.

## Preparar o ambiente no Manjaro

```bash
sudo pacman -S --needed git github-cli nodejs npm chromium vulkan-tools rsync

gh auth login
vulkaninfo --summary
```

Confira o WebGPU em `chrome://gpu`.

## Compilar e publicar tudo

```bash
cd maximus-engenharia-inteligente-pwa
./scripts/build-and-publish.sh
```

Variáveis opcionais:

```bash
GITHUB_OWNER=glaucodeveloper \
WEB_REPO=maximus-engenharia-inteligente \
DATA_REPO=maximus-engenharia-inteligente-data \
RENAME_EXISTING=1 \
./scripts/build-and-publish.sh
```

O script:

1. renomeia ou cria os dois repositórios;
2. atualiza `public/app-config.json`;
3. instala as dependências pelo registry público;
4. valida e compila o PWA;
5. envia o frontend;
6. ativa o GitHub Pages por Actions;
7. instala o workflow de confirmação no repositório privado.

## Configurar confirmação de e-mail

No repositório privado de dados, abra:

`Settings → Secrets and variables → Actions`

Crie:

- `SMTP_HOST`;
- `SMTP_PORT`;
- `SMTP_USERNAME`;
- `SMTP_PASSWORD`;
- `SMTP_FROM`.

O workflow fica em `.github/workflows/confirm-email.yml` no repositório de dados.

A implementação é adequada para um ambiente privado controlado. A solicitação temporária contém o link de confirmação no histórico privado do Git até ser removida da branch. Para autenticação pública de alta segurança, substitua esse fluxo por um serviço de identidade ou backend dedicado.

## Desenvolvimento

```bash
npm ci --registry=https://registry.npmjs.org
npm run doctor
npm run validate
npm run dev
```

## Gerar um ZIP

```bash
npm run package
```

O script usa `zip` quando disponível e recorre ao Python quando o pacote `zip` não está instalado.

## Segurança

Use um fine-grained personal access token limitado exclusivamente ao repositório privado de dados, com `Contents: Read and write`. O token não é entregue ao modelo. Quem possui acesso administrativo ao repositório de dados consegue consultar todos os namespaces.


## Correção 1.0.1

- serializa a inicialização do LiteRT-LM para evitar múltiplos ambientes WebGPU;
- limita a janela de geração a 2048 tokens no navegador;
- detecta fluxos compostos por `<pad>`, cancela a sessão e tenta uma conversa nova uma vez;
- apresenta erro acionável se o acelerador continuar produzindo token 0;
- versiona o arquivo do modelo no OPFS, forçando novo download após a atualização;
- corrige o service worker para clonar respostas antes do consumo e não cachear modelos ou requisições Range.


## Correção 1.0.2 — proteção contra tokens internos

A versão 1.0.2 valida o modelo antes de liberar o chat. Tokens internos como `<pad>`, ciclos de repetição e respostas vazias são interrompidos dentro da camada de geração e nunca são enviados para a interface. Quando o teste falha, o modelo local é removido e a inteligência fica desativada até uma nova preparação.

Para atualizar o repositório de engenharia já publicado:

```bash
chmod +x scripts/update-engineering-repo.sh
./scripts/update-engineering-repo.sh
```

O script renomeia `okf-chat-web` para `maximus-engenharia-inteligente` quando necessário, compila, valida, envia a atualização e configura o GitHub Pages para GitHub Actions.

## Atualização 1.0.3

O script `scripts/update-engineering-repo.sh` publica por meio de um checkout temporário limpo. Ele não tenta mesclar o histórico remoto dentro da pasta extraída, evitando o erro “untracked working tree files would be overwritten by merge”.

O repositório padrão é `maximus-assistente-deredelocal`. Para outro nome:

```bash
WEB_REPO=maximus-engenharia-inteligente ./scripts/update-engineering-repo.sh
```
