# Configuração GitHub da aplicação

A configuração do repositório de dados está versionada no próprio
projeto Engenharia:

```text
config/github-data.json
```

Destino:

```text
glaucodeveloper/maximus-engenharia-inteligente-data
```

O servidor não cria outro repositório e a interface não permite alterar
esse destino.

## Fine-grained PAT

Ao criar o token no GitHub, selecione somente:

```text
glaucodeveloper/maximus-engenharia-inteligente-data
```

Permissões:

- Contents: Read and write;
- Metadata: Read-only.

A interface solicita somente esse PAT.

## Hugging Face

O token `hf_...` é configurado no script de patching e disponibilizado
ao bootstrap por `systemd-creds`.
