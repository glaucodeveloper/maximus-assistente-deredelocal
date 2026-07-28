# Instalação Linux

## Credenciais

O token do Hugging Face é configurado no console:

```bash
./linux/configurar-huggingface-token.sh
```

Ele é criptografado com `systemd-creds` e disponibilizado somente ao
`engenharia-bootstrap.service`. O token não é enviado ao navegador e não
é persistido no repositório.

Depois, abra:

```text
http://127.0.0.1:3001
```

A interface solicita somente:

- Personal Access Token do GitHub;
- nome do repositório privado, com padrão `engenharia-data`.

O PAT do GitHub também é protegido com `systemd-creds` durante a
configuração e permanece vinculado ao identificador SHA-256 do MAC.

## Serviços

- `engenharia-bootstrap.service`: configuração inicial;
- `engenharia-litert.service`: Gemma 4 E2B via LiteRT-LM;
- `engenharia-nim.service`: aplicação definitiva.
