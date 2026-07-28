# Engenharia 3.0

A aplicação passa a usar:

- servidor local em Nim;
- repositório privado `engenharia-data` no lugar do FTP;
- PAT do GitHub protegido por DPAPI `LocalMachine`;
- entropia adicional derivada do MAC físico;
- Gemma 4 E2B Mobile Text-only em LiteRT-LM;
- servidor OpenAI-compatible do LiteRT-LM em `127.0.0.1:9379`;
- instalador MSI x64 produzido com WiX.

## Compilar no Windows

Pré-requisitos no `PATH`:

- Node.js;
- Nim 2;
- WiX Toolset;
- PowerShell.

```powershell
npm run build:msi
```

Resultado:

```text
dist\Engenharia-3.0.0-x64.msi
```

Após instalar o MSI:

```text
C:\Program Files\Engenharia\Configure-Engenharia.cmd
```

O configurador solicita:

1. Personal Access Token do GitHub;
2. token do Hugging Face autorizado para Gemma;
3. nome do repositório, quando diferente de `engenharia-data`.

O repositório é criado como privado quando não existe. O PAT não é
enviado ao repositório. O GitHub recebe somente o identificador SHA-256
da máquina em `machines/<hash>.json`.

## Serviços

- `EngenhariaLiteRTLM`;
- `EngenhariaNimServer`.

## Modelo

```text
Repositório: litert-community/gemma-4-E2B-it-litert-lm
Arquivo:     gemma-4-E2B-it.litertlm
Alias:       gemma4-e2b
Runtime:     LiteRT-LM
```
