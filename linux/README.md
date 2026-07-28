# Instalação Linux

Execute no Manjaro/Arch:

```bash
PROJECT_DIR="$HOME/dev/engenharia" \
AUTO_PUSH=1 \
./linux/instalar-servidor-local.sh
```

O instalador:

- compila o servidor Nim;
- cria ou reutiliza `engenharia-data`;
- protege o PAT com `systemd-creds`, quando disponível;
- associa a configuração ao MAC selecionado;
- instala LiteRT-LM;
- importa Gemma 4 E2B;
- registra os serviços de usuário:
  - `engenharia-litert.service`;
  - `engenharia-nim.service`;
- desativa o servidor Node legado.

O servidor web definitivo fica em:

```text
http://127.0.0.1:3001
```
