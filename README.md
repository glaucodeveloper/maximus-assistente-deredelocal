# Maximus — Central Local de Engenharia

Servidor local para organização de documentos técnicos, OKF, tarefas, upload
HTTP/FTPS e assistência por modelo executado na própria máquina.

## Componentes

- Node.js 22+ e Express;
- SQLite local;
- HTTPS e FTPS;
- token de acesso vinculado ao endereço físico observado da máquina;
- Transformers.js 4.2;
- modelo principal `onnx-community/gemma-3-1b-it-ONNX`, Q4;
- fallback `onnx-community/Qwen2.5-0.5B-Instruct`;
- pipeline PDF/TXT/Markdown → OKF;
- interface web em `public/`.

## Instalação

```bash
git clone git@github.com:glaucodeveloper/maximus-assistente-deredelocal.git
cd maximus-assistente-deredelocal
chmod +x install-service.sh
./install-service.sh
```

O instalador:

1. gera certificado TLS local;
2. instala dependências;
3. valida o código;
4. executa testes;
5. prepara o modelo;
6. instala o serviço systemd do usuário;
7. emite o primeiro token de pareamento.

Acesse `https://<endereço-do-servidor>:3001`.

## Pareamento

O token administrativo de pareamento é usado uma vez. Após o cadastro, a
aplicação recebe um token de acesso que somente funciona junto ao endereço da
máquina observado pelo servidor.

```bash
npm run pairing:issue -- --hours 24
npm run devices:list
npm run device:revoke -- DEV-...
npm run pairing:issue -- --user USR-... --hours 24
```

Consulte [SECURITY.md](SECURITY.md).

## Modelo local

```bash
npm run model:prepare
```

Configuração em `~/.config/engenharia/engenharia.env`:

```dotenv
MODEL_ID=onnx-community/gemma-3-1b-it-ONNX
MODEL_FALLBACK_ID=onnx-community/Qwen2.5-0.5B-Instruct
MODEL_DTYPE=q4
MODEL_DEVICE=
MODEL_CACHE_DIR=/caminho/do/projeto/.cache/transformers
```

`MODEL_DEVICE` vazio usa o backend de CPU do Node. O primeiro carregamento
baixa e armazena o modelo no cache local.

## Dados

Os seguintes artefatos são locais e não devem entrar no Git:

```text
okf/db.sqlite*
okf/manifest.json
okf/uploads_raw/
okf/knowledge/
.cache/
.env*
```

O commit `0beadbfd...` incluiu arquivos SQLite. Removê-los em outro commit não
os apaga do histórico. Use `scripts/purge-sensitive-history.sh` após revisar o
backup e entender o force-push.

## Limitações

O vínculo pelo MAC/endereço físico funciona no mesmo segmento de rede local.
Ele não substitui certificado de cliente ou WebAuthn contra um atacante com
controle administrativo da máquina e da rede.

O pacote `ftp-srv` possui manutenção pouco frequente. FTPS fica protegido por
TLS e pode ser desativado com `FTP_ENABLED=0`. Para exposição fora da LAN,
prefira SFTPGo/OpenSSH e um gateway de autenticação dedicado.
