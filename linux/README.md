# Instalação Linux com configuração pela interface

O instalador não solicita PAT nem token do Hugging Face no terminal.

Ele inicia `engenharia-bootstrap.service` em:

```text
http://127.0.0.1:3001
```

A interface solicita:

- Personal Access Token do GitHub;
- token do Hugging Face;
- nome do repositório privado, com padrão `engenharia-data`.

O PAT não é persistido no navegador. O servidor de configuração Nim o
protege com `systemd-creds`, e o servidor definitivo valida o SHA-256 do
MAC antes de recuperar a credencial.

Depois da importação do Gemma 4 E2B, a própria interface ativa:

- `engenharia-litert.service`;
- `engenharia-nim.service`.

O bootstrap é então desativado.
