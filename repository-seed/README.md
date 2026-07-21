# Base privada — Maximus Engenharia Inteligente

Este conteúdo inicial deve ser publicado em um repositório **privado**, separado do frontend hospedado no GitHub Pages.

Estrutura:

- `okf/`: conhecimento corporativo estruturado;
- `data/users/`: identidades, artefatos e OKFs individuais;
- `data/verification-requests/`: solicitações temporárias de confirmação de e-mail;
- `.github/workflows/confirm-email.yml`: envio das confirmações por SMTP.

## Segurança

Não inclua tokens GitHub, senhas SMTP ou chaves privadas nos arquivos. Os segredos de e-mail ficam em **Settings → Secrets and variables → Actions** no repositório de dados.

Os arquivos `account.json` guardam hashes de senha, não senhas em texto aberto. Ainda assim, mantenha este repositório privado e restrinja o token do PWA somente a ele.
