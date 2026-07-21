---
type: concept
title: "OKF Chat"
tags: [okf, chat, local-llm]
---

# OKF Chat

OKF Chat é uma aplicação frontend instalada como PWA. O modelo Gemma 4 é executado localmente com LiteRT-LM. A base compartilhada e os namespaces dos usuários ficam em um repositório privado no GitHub.

## Princípios

- O token do GitHub permanece no navegador.
- O modelo local não recebe o token.
- Ferramentas de leitura podem consultar arquivos e documentos OKF.
- Ferramentas de escrita exigem aprovação do usuário.
