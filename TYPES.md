# Engenharia - Especificação Técnica de Tipos e Gramática Formal

Este documento descreve as especificações técnicas de dados e o modelo de execução do servidor local do projeto **Engenharia**. A especificação adota a notação **EBNF (Extended Backus-Naur Form)** para documentar de forma rigorosa as estruturas de dados e o comportamento lógico do sistema.

---

## 1. Descrição do Sistema

O sistema consiste em um servidor de arquivos e dados composto por quatro componentes integrados:
1. **Banco de Dados Relacional**: Persistência baseada em SQLite local (`okf/db.sqlite`) para gerenciamento de usuários, permissões, tarefas e metadados de documentos.
2. **Servidor de Arquivos (FTP)**: Isolamento de diretórios por usuário com regras de permissão assíncronas para transferências interbancárias de arquivos técnicos.
3. **Pipeline de Padronização (IA)**: Detector de eventos de upload que extrai texto de arquivos brutos (PDF, TXT, MD) e executa o processamento via Gemini API para conversão em formato estruturado OKF (Obsidian Knowledge Folders).
4. **Interface REST e RAG (Chat de IA)**: API de integração para gerenciamento web do sistema e consulta semântica ao repositório de documentos processados.

---

## 2. Gramática de Estruturação (Modelagem de Dados)

Abaixo está descrita a modelagem formal das estruturas de dados persistidas e manipuladas pelo sistema.

### A. Definição Formal em EBNF

```ebnf
(* Estruturas principais de dados *)
DataModel = User | Permission | Task | Document ;

(* Estrutura do Usuário *)
User = "{" , MacProp , "," , IpProp , "," , NameProp , "," , RoleProp , "," , SectorProp , "," , RegisteredAtProp , "}" ;
MacProp          = '"mac"' , ":" , String ;          (* Endereço MAC do dispositivo físico *)
IpProp           = '"ip"' , ":" , String ;           (* Endereço IP do dispositivo na rede local *)
NameProp         = '"name"' , ":" , String ;         (* Nome completo do operador do sistema *)
RoleProp         = '"role"' , ":" , String ;         (* Cargo técnico ou administrativo *)
SectorProp       = '"sector"' , ":" , String ;       (* Setor técnico da engenharia *)
RegisteredAtProp = '"registered_at"' , ":" , Date ;  (* Carimbo de data/hora do registro *)

(* Estrutura de Permissão de Upload *)
Permission = "{" , IdProp , "," , RequesterMacProp , "," , TargetUsernameProp , "," , PermissionStatusProp , "," , RequestedAtProp , [ "," , RequesterNameProp , "," , RequesterRoleProp , "," , RequesterSectorProp ] , "}" ;
IdProp               = '"id"' , ":" , Integer ;            (* Identificador numérico único sequencial *)
RequesterMacProp     = '"requester_mac"' , ":" , String ;  (* MAC do solicitante da permissão *)
TargetUsernameProp   = '"target_username"' , ":" , String; (* Diretório FTP de destino solicitado *)
PermissionStatusProp = '"status"' , ":" , StatusValue ;    (* Status da autorização de gravação *)
RequestedAtProp      = '"requested_at"' , ":" , Date ;     (* Carimbo de data/hora da solicitação *)
RequesterNameProp    = '"requester_name"' , ":" , String ;  (* Nome do solicitante (para exibições agrupadas) *)
RequesterRoleProp    = '"requester_role"' , ":" , String ;  (* Cargo do solicitante *)
RequesterSectorProp  = '"requester_sector"' , ":" , String;(* Setor do solicitante *)
StatusValue          = '"pending"' | '"approved"' | '"rejected"' ;

(* Estrutura de Tarefa *)
Task = "{" , IdProp , "," , TitleProp , "," , DescriptionProp , "," , AssignedToMacProp , "," , TaskStatusProp , "," , CreatedAtProp , [ "," , AssignedToNameProp , "," , AssignedToRoleProp ] , "}" ;
TitleProp          = '"title"' , ":" , String ;          (* Título descritivo da tarefa *)
DescriptionProp    = '"description"' , ":" , String ;    (* Detalhamento das atividades requeridas *)
AssignedToMacProp  = '"assigned_to_mac"' , ":" , String ;(* MAC do dispositivo do responsável *)
TaskStatusProp     = '"status"' , ":" , TaskStatusValue ;(* Estado atual de execução *)
CreatedAtProp      = '"created_at"' , ":" , Date ;       (* Carimbo de data/hora de criação *)
AssignedToNameProp = '"assigned_to_name"' , ":" , String;(* Nome do responsável atribuído *)
AssignedToRoleProp = '"assigned_to_role"' , ":" , String;(* Cargo do responsável atribuído *)
TaskStatusValue    = '"pending"' | '"in_progress"' | '"completed"' ;

(* Estrutura de Documento OKF *)
Document = "{" , PathProp , "," , TitleProp , "," , DescriptionProp , "," , TagsProp , "," , AuthorNameProp , "," , AuthorRoleProp , "," , SourceFileProp , "," , UploadedByMacProp , "," , UploadedAtProp , "}" ;
PathProp          = '"path"' , ":" , String ;            (* Caminho de persistência no OKF (ex: "knowledge/manual.md") *)
TagsProp          = '"tags"' , ":" , "[" , { String , [ "," ] } , "]" ; (* Marcadores categóricos gerados *)
AuthorNameProp    = '"author_name"' , ":" , String ;     (* Nome do operador que realizou o upload *)
AuthorRoleProp    = '"author_role"' , ":" , String ;     (* Cargo do operador autor *)
SourceFileProp    = '"source_file"' , ":" , String ;     (* Nome original do arquivo técnico enviado *)
UploadedByMacProp = '"uploaded_by_mac"' , ":" , String ; (* MAC do dispositivo que efetuou o upload *)
UploadedAtProp    = '"uploaded_at"' , ":" , Date ;       (* Carimbo de data/hora do processamento *)
```

### B. Especificação de Tipos Primitivos

```ebnf
Digit       = "0" | "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9" ;
Letter      = "a" | "b" | ... | "z" | "A" | "B" | ... | "Z" ;
Character   = Letter | Digit | "_" | "-" | "." | "@" | " " | "/" | ":" | "," | "?" | "!" | "(" | ")" | "[" | "]" | "\n" | '"' | "'" ;
Integer     = Digit , { Digit } ;
Boolean     = "true" | "false" ;
String      = '"' , { Character } , '"' ;
Date        = '"' , Year , "-" , Month , "-" , Day , "T" , Hour , ":" , Minute , ":" , Second , "." , Millisecond , "Z" , '"' ;
Year        = Digit , Digit , Digit , Digit ;
Month       = Digit , Digit ;
Day         = Digit , Digit ;
Hour        = Digit , Digit ;
Minute      = Digit , Digit ;
Second      = Digit , Digit ;
Millisecond = Digit , Digit , Digit ;
```

---

## 3. Gramática de Funcionamento (Comportamento Lógico & APIs)

Esta seção especifica as rotinas de manipulação do sistema, mapeadas por suas assinaturas lógicas de funções internas e contratos de endpoints HTTP da API REST.

### A. Assinaturas de Funções dos Serviços Internos

```ebnf
(* Operações de Persistência (Serviço DB) *)
DBSignature = CreateUser | GetUserByMac | GetUserByIp | GetUserByUsername | ListUsers | UpdateUserIp
            | CreatePermission | CheckPermission | ListPendingPermissions | ListAllPermissions | UpdatePermission
            | CreateTask | ListTasks | UpdateTask
            | CreateDocument | ListDocuments ;

CreateUser             = "createUser(mac: String, ip: String, name: String, role: String, sector: String) -> User" ;
GetUserByMac           = "getUserByMac(mac: String) -> User | null" ;
GetUserByIp            = "getUserByIp(ip: String) -> User | null" ;
GetUserByUsername      = "getUserByUsername(username: String) -> User | null" ;
ListUsers              = "listUsers() -> Array of User" ;
UpdateUserIp           = "updateUserIp(mac: String, ip: String) -> void" ;

CreatePermission       = "createPermissionRequest(requesterMac: String, targetUsername: String) -> void" ;
CheckPermission        = "checkPermission(requesterMac: String, targetUsername: String) -> Permission | null" ;
ListPendingPermissions = "listPendingPermissions() -> Array of Permission" ;
ListAllPermissions     = "listAllPermissions() -> Array of Permission" ;
UpdatePermission       = "updatePermissionStatus(id: Integer, status: StatusValue) -> void" ;

CreateTask             = "createTask(title: String, description: String, assignedToMac: String) -> void" ;
ListTasks              = "listTasks() -> Array of Task" ;
UpdateTask             = "updateTaskStatus(id: Integer, status: TaskStatusValue) -> void" ;

CreateDocument         = "createDocument(path: String, title: String, description: String, tags: Array of String, authorName: String, authorRole: String, sourceFile: String, uploadedByMac: String) -> void" ;
ListDocuments          = "listDocuments() -> Array of Document" ;

(* Operações de Processamento Inteligente (Serviço Gemini) *)
GeminiSignature = StandardizeDocument | AskEngineeringChat ;

StandardizeDocument    = "standardizeDocument(text: String, fileName: String, author: User) -> { markdown: String, title: String, description: String, tags: Array of String }" ;
AskEngineeringChat     = "askEngineeringChat(question: String, contextDocs: Array of Document, user: User) -> String" ;

(* Operações de Monitoramento e Automação (Serviço Pipeline) *)
PipelineSignature = ProcessFile | RebuildManifest ;

ProcessFile            = "processFile(rawFilePath: String, fileName: String) -> { success: Boolean, [ document: Document | error: String ] }" ;
RebuildManifest        = "rebuildManifest() -> void" ;
```

### B. Contratos de Rotas da API REST

```ebnf
(* Rotas de Operação da Interface REST *)
HttpAPI = GetMe | RegisterUser | ListUsers | RequestPermission | RespondPermission | ListPendingPerms | ListAllPerms | CreateTaskRoute | ListTasksRoute | UpdateTaskRoute | AskChat | ListDocs ;

GetMe               = "GET /api/user/me -> User | { registered: false, ip: String, mac: String }" ;
RegisterUser        = "POST /api/user/register { name: String, role: String, sector: String } -> { success: true, user: User }" ;
ListUsers           = "GET /api/user/list -> Array of User" ;

RequestPermission   = "POST /api/permissions/request { targetUsername: String } -> { success: true, message: String }" ;
RespondPermission   = "POST /api/permissions/respond { id: Integer, status: StatusValue } -> { success: true }" ;
ListPendingPerms    = "GET /api/permissions/pending -> Array of Permission" ;
ListAllPerms        = "GET /api/permissions/list -> Array of Permission" ;

CreateTaskRoute     = "POST /api/tasks/create { title: String, description: String, assignedToMac: String } -> { success: true }" ;
ListTasksRoute      = "GET /api/tasks/list -> Array of Task" ;
UpdateTaskRoute     = "POST /api/tasks/update { id: Integer, status: TaskStatusValue } -> { success: true }" ;

AskChat             = "POST /api/chat/ask { question: String } -> { response: String }" ;
ListDocs            = "GET /api/documents/list -> Array of Document" ;
```
