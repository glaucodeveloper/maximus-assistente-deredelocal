# Plano de Implementação — Servidor "Engenharia" RAG, FTP Isolado e Controle de Acesso

Este documento detalha arquitetura e implementação de servidor local **"Engenharia"**. Inclui servidor FTP multiusuário com restrição de escrita, cadastro por IP/MAC, interface web para gestão de arquivos/permissões, notificações de pedidos, gerenciador de tarefas (tasks) e chat de inteligência artificial (RAG com Gemini 2.5 Flash).

---

## 1. Estrutura de Diretórios (`dev/engenharia`)

```
dev/engenharia/
├── package.json             # Dependências Node.js (express, ftp-srv, pdf-parse, etc.)
├── .env                     # Credenciais do Gemini e portas
├── server.js                # Inicializador de servidores (Express + FTP + Watcher)
├── services/
│   ├── db.js                # Persistência SQLite local (node:sqlite)
│   ├── gemini.js            # Integração Gemini API (Padronização e RAG)
│   └── pipeline.js          # Regras de negócio, leitura ARP/MAC e processador de PDFs
├── public/
│   ├── index.html           # Interface SPA (Tailwind CSS, Lucide Icons, painel unificado)
│   └── app.js               # Lógica do chat RAG, cadastro de usuário e gestão de arquivos/pedidos
└── okf/
    ├── db.sqlite            # Banco de dados local SQLite
    ├── manifest.json        # Manifesto de arquivos padrão OKF
    ├── uploads_raw/         # Raiz do servidor FTP
    │   ├── .archive/        # Cópia segura dos originais processados
    │   ├── joao/            # Pasta privada do usuário João
    │   └── maria/           # Pasta privada da usuária Maria
    └── knowledge/           # Documentos finais padronizados em Markdown com Frontmatter YAML
```

---

## 2. Banco de Dados SQLite (`okf/db.sqlite`)

Esquema de tabelas nativo para gerenciar usuários, permissões, tarefas e arquivos:

1. **`users`**:
   - `mac` TEXT PRIMARY KEY (Identificador permanente do dispositivo)
   - `ip` TEXT (IP atual na rede local)
   - `name` TEXT (Nome do usuário)
   - `role` TEXT (Função na engenharia)
   - `sector` TEXT (Setor de atuação)
   - `registered_at` TEXT

2. **`permissions`**:
   - `id` INTEGER PRIMARY KEY AUTOINCREMENT
   - `requester_mac` TEXT (Quem pediu)
   - `target_user_mac` TEXT (Dono da pasta alvo)
   - `status` TEXT ('pending', 'approved', 'rejected')
   - `requested_at` TEXT

3. **`tasks`**:
   - `id` INTEGER PRIMARY KEY AUTOINCREMENT
   - `title` TEXT
   - `description` TEXT
   - `assigned_to_mac` TEXT (Dispositivo/Usuário responsável)
   - `status` TEXT ('pending', 'in_progress', 'completed')
   - `created_at` TEXT

4. **`documents`**:
   - `path` TEXT PRIMARY KEY
   - `title` TEXT
   - `description` TEXT
   - `tags` TEXT (Array JSON)
   - `author_name` TEXT
   - `author_role` TEXT
   - `source_file` TEXT
   - `uploaded_by_mac` TEXT
   - `uploaded_at` TEXT

---

## 3. Segurança e Controle de Acesso no FTP (`ftp-srv`)

1. **Estrutura de Pastas**:
   - Raiz do FTP: `okf/uploads_raw/`.
   - Cada usuário cadastrado possui uma subpasta própria de upload (`okf/uploads_raw/<username>/`).
2. **Navegação e Download**:
   - Qualquer usuário pode navegar por todas as pastas e baixar qualquer arquivo.
3. **Escrita (Upload/Sobrescrita)**:
   - **Lógica**: Permitida na própria pasta por padrão.
   - **Cross-user**: Tentar fazer upload na pasta de outro usuário exige entrada prévia de permissão (`approved` na tabela `permissions`).
   - **Implementação**: Customização do módulo FileSystem do `ftp-srv`:
     ```javascript
     // Intercepta comando de escrita
     write(fileName, { append = false } = {}) {
       const clientIp = this.connection.ip;
       const user = db.getUserByIp(clientIp);
       const targetFolder = getTargetUserFolder(fileName);
       
       if (user.username !== targetFolder) {
         const permission = db.checkPermission(user.mac, targetFolder);
         if (!permission || permission.status !== 'approved') {
           // Gera notificação pendente no sistema e rejeita upload FTP
           db.createPermissionRequest(user.mac, targetFolder, fileName);
           throw new Error("Negado: Requer autorização do proprietário da pasta.");
         }
       }
       return super.write(fileName, { append });
     }
     ```

---

## 4. Pipeline de Padronização IA e OKF

1. O pipeline monitora `okf/uploads_raw/**/*.pdf` (e `.txt`, `.md`).
2. Identifica o autor do upload cruzando o caminho do arquivo com a tabela de usuários (ou mapeia IP do evento `STOR`).
3. Extrai texto bruto (usando `pdf-parse` para arquivos PDF).
4. Envia o texto ao Gemini 2.5 Flash para padronizar em Markdown OKF com YAML Frontmatter de autoria automática.
5. Grava arquivo final em `okf/knowledge/` e move original para `okf/uploads_raw/.archive/`.

---

## 5. Painéis da Interface Web (`public/`)

- **Cadastro de Dispositivo**: Formulário obrigatório caso IP/MAC não estejam no banco de dados.
- **Explorador FTP**: Visualização de arquivos por pasta de usuário, botão para baixar e botão "Solicitar Permissão de Upload" para pastas alheias.
- **Central de Notificações**:
  - Exibe pedidos de permissão recebidos (com botões "Aprovar" / "Rejeitar").
  - Alertas de arquivos novos processados.
- **Painel de Tarefas (Tasks)**:
  - Criação de atribuições para membros da equipe.
  - Atualização de status da tarefa diretamente na interface.
- **Chat Inteligente (RAG)**: Chatbot integrado que localiza os arquivos técnicos de engenharia e responde as perguntas com precisão de IA.
