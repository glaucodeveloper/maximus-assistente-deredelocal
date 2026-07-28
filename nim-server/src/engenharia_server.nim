import std/[asyncdispatch, asynchttpserver, base64, httpclient, httpcore,
  json, os, osproc, sequtils, strutils, times, uri]

type Config = object
  port: Port
  publicDir, secretPath, owner, repo, branch, macHash: string
  liteRtUrl, modelAlias, displayName: string

const
  GitHubApi = "https://api.github.com"

when defined(windows):
  const EntropyPrefix = "EngenhariaData|"

proc jsonHeaders(): HttpHeaders =
  newHttpHeaders([("Content-Type","application/json; charset=utf-8"),
                  ("Cache-Control","no-store")])

proc textHeaders(kind: string): HttpHeaders =
  newHttpHeaders([("Content-Type",kind),("Cache-Control","no-store")])

proc normalizeMac(s: string): string =
  for ch in s:
    if ch in HexDigits: result.add(ch.toUpperAscii())

proc primaryMac(): string =
  let configured =
    normalizeMac(getEnv("ENGINEERING_MACHINE_MAC"))

  if configured.len == 12:
    return configured

  when defined(windows):
    let outp = execProcess("getmac", args=["/fo","csv","/nh"],
      options={poUsePath,poStdErrToStdOut})
    for line in outp.splitLines:
      for token in line.split(','):
        let candidate = normalizeMac(token)
        if candidate.len == 12: return candidate
  else:
    for item in walkDir("/sys/class/net"):
      if item.kind == pcDir and item.path.extractFilename != "lo":
        let p = item.path / "address"
        if fileExists(p):
          let candidate = normalizeMac(readFile(p))
          if candidate.len == 12: return candidate
  raise newException(IOError, "Nenhum MAC físico foi localizado.")

proc sha256Hex(value: string): string =
  when defined(windows):
    let cmd = "$b=[Text.Encoding]::UTF8.GetBytes('" & value &
      "');$h=[Security.Cryptography.SHA256]::Create().ComputeHash($b);" &
      "([BitConverter]::ToString($h)).Replace('-','').ToLowerInvariant()"
    result = execProcess("powershell.exe",
      args=["-NoProfile","-NonInteractive","-Command",cmd],
      options={poUsePath,poStdErrToStdOut}).strip
  else:
    let hashed = execCmdEx(
      "sha256sum",
      options = {poUsePath, poStdErrToStdOut},
      input = value
    )
    let fields = hashed.output.splitWhitespace()

    if hashed.exitCode != 0 or fields.len == 0:
      raise newException(
        IOError,
        "Não foi possível calcular o SHA-256 do MAC."
      )

    result = fields[0].toLowerAscii()

proc decryptPat(path, mac: string): string =
  when defined(windows):
    let p = path.replace("'","''")
    let entropy = (EntropyPrefix & mac).replace("'","''")
    let cmd = "$c=[IO.File]::ReadAllBytes('" & p & "');" &
      "$e=[Text.Encoding]::UTF8.GetBytes('" & entropy & "');" &
      "$d=[Security.Cryptography.ProtectedData]::Unprotect(" &
      "$c,$e,[Security.Cryptography.DataProtectionScope]::LocalMachine);" &
      "[Text.Encoding]::UTF8.GetString($d)"
    result = execProcess("powershell.exe",
      args=["-NoProfile","-NonInteractive","-Command",cmd],
      options={poUsePath,poStdErrToStdOut}).strip
  else:
    let credentialsDirectory =
      getEnv("CREDENTIALS_DIRECTORY").strip

    if credentialsDirectory.len > 0:
      let credentialPath =
        credentialsDirectory / "github-pat"

      if fileExists(credentialPath):
        result = readFile(credentialPath).strip

    if result.len == 0:
      result = getEnv("ENGINEERING_GITHUB_PAT").strip

  if result.len == 0:
    raise newException(IOError, "O PAT protegido não pôde ser recuperado.")

proc loadConfig(path: string): Config =
  let n = parseFile(path)
  result.port = Port(n{"port"}.getInt(3001))
  result.publicDir = n{"publicDir"}.getStr
  result.secretPath = n{"secretPath"}.getStr
  result.owner = n{"githubOwner"}.getStr
  result.repo = n{"githubRepo"}.getStr("engenharia-data")
  result.branch = n{"githubBranch"}.getStr("main")
  result.macHash = n{"macHash"}.getStr
  result.liteRtUrl = n{"litertBaseUrl"}.getStr("http://127.0.0.1:9379")
  result.modelAlias = n{"modelAlias"}.getStr("gemma4-e2b")
  result.displayName = n{"displayName"}.getStr("Administrador")

proc ghClient(pat: string): HttpClient =
  result = newHttpClient(timeout = 60_000)
  result.headers = newHttpHeaders([
    ("Accept","application/vnd.github+json"),
    ("Authorization","Bearer " & pat),
    ("X-GitHub-Api-Version","2022-11-28"),
    ("User-Agent","engenharia-nim/3.0")
  ])

proc repoBase(c: Config): string =
  GitHubApi & "/repos/" & encodeUrl(c.owner) & "/" & encodeUrl(c.repo)

proc encodePath(path: string): string =
  path.split('/').mapIt(encodeUrl(it)).join("/")

proc ensureRepo(c: Config, pat: string) =
  var h = ghClient(pat); defer: h.close
  let found = h.request(repoBase(c), httpMethod = HttpGet)
  if found.code == Http200: return
  if found.code != Http404:
    raise newException(IOError, "Falha ao consultar repositório: " & found.body)
  let body = %*{"name":c.repo,"private":true,"auto_init":true,
    "description":"Dados privados da aplicação Engenharia"}
  let made = h.request(GitHubApi & "/user/repos",
    httpMethod = HttpPost, body = $body)
  if made.code notin {Http201,Http422}:
    raise newException(IOError, "Falha ao criar repositório: " & made.body)

proc getFile(c: Config, pat, path: string):
    tuple[found: bool, content, sha: string] =
  var h = ghClient(pat); defer: h.close
  let url = repoBase(c) & "/contents/" & encodePath(path) &
    "?ref=" & encodeUrl(c.branch)
  let r = h.request(url, httpMethod = HttpGet)
  if r.code == Http404: return (false,"","")
  if r.code != Http200:
    raise newException(IOError, "Falha ao ler " & path & ": " & r.body)
  let n = parseJson(r.body)
  (true, decode(n{"content"}.getStr.replace("\n","")), n{"sha"}.getStr)

proc putFile(c: Config, pat, path, content, message: string) =
  let old = getFile(c,pat,path)
  var body = %*{"message":message,"content":encode(content),"branch":c.branch}
  if old.found: body["sha"] = %old.sha
  var h = ghClient(pat); defer: h.close
  let r = h.request(repoBase(c) & "/contents/" & encodePath(path),
    httpMethod = HttpPut, body = $body)
  if r.code notin {Http200,Http201}:
    raise newException(IOError, "Falha ao gravar " & path & ": " & r.body)

proc listDocs(c: Config, pat: string): JsonNode =
  result = newJArray()
  var h = ghClient(pat); defer: h.close
  let r = h.request(repoBase(c) & "/contents/documents?ref=" &
    encodeUrl(c.branch), httpMethod = HttpGet)
  if r.code == Http404: return
  if r.code != Http200:
    raise newException(IOError, "Falha ao listar documentos: " & r.body)
  for item in parseJson(r.body).items:
    let name = item{"name"}.getStr
    if item{"type"}.getStr == "file" and name.toLowerAscii.endsWith(".md"):
      result.add(%*{"title":name.changeFileExt("").replace("-"," "),
        "path":"documents/" & name,
        "description":"Documento no repositório GitHub privado.",
        "tags":["GitHub","Engenharia"],"author_name":c.displayName,
        "author_role":"Repositório",
        "uploaded_at":now().utc.format("yyyy-MM-dd'T'HH:mm:ss'Z'")})

proc readTasks(c: Config, pat: string): JsonNode =
  let f = getFile(c,pat,"state/tasks.json")
  if not f.found: return newJArray()
  try:
    result = parseJson(f.content)
    if result.kind != JArray: result = newJArray()
  except CatchableError: result = newJArray()

proc writeTasks(c: Config, pat: string, tasks: JsonNode) =
  putFile(c,pat,"state/tasks.json",pretty(tasks),"Atualizar atividades")

proc callModel(c: Config, question, context: string): string =
  var h = newHttpClient(timeout = 600_000); defer: h.close
  h.headers = newHttpHeaders([("Content-Type","application/json")])
  let body = %*{"model":c.modelAlias,"temperature":0.1,"max_tokens":512,
    "stream":false,"messages":[
      {"role":"system","content":
        "Você é o Assistente Local de Engenharia. Responda em português " &
        "com precisão técnica. Não invente normas, medidas ou requisitos."},
      {"role":"user","content":"Pergunta: " & question &
        "\n\nCONTEXTO AUTORIZADO:\n" & context}]}
  let r = h.request(c.liteRtUrl & "/v1/chat/completions",
    httpMethod = HttpPost, body = $body)
  if r.code != Http200:
    raise newException(IOError, "LiteRT-LM: " & r.body)
  result = parseJson(r.body){"choices"}[0]{"message"}{"content"}.getStr

proc contextFor(c: Config, pat, question: string):
    tuple[text: string, sources: JsonNode] =
  result.sources = newJArray()
  let docs = listDocs(c,pat)
  var blocks: seq[string] = @[]
  var used = 0
  for d in docs.items:
    if used >= 2: break
    let f = getFile(c,pat,d{"path"}.getStr)
    if f.found:
      let snippet = if f.content.len > 3000: f.content[0..<3000] else: f.content
      blocks.add("FONTE: " & d{"title"}.getStr & "\n" & snippet)
      result.sources.add(%*{"title":d{"title"}.getStr,
        "path":d{"path"}.getStr,"author":c.displayName & " (GitHub)"})
      inc used
  result.text = blocks.join("\n\n---\n\n")

proc mime(path: string): string =
  case path.splitFile.ext.toLowerAscii
  of ".html": "text/html; charset=utf-8"
  of ".js": "text/javascript; charset=utf-8"
  of ".css": "text/css; charset=utf-8"
  of ".json": "application/json; charset=utf-8"
  of ".svg": "image/svg+xml"
  of ".png": "image/png"
  else: "application/octet-stream"

proc configPath(): string =
  when defined(windows):
    result = getEnv("PROGRAMDATA","C:\\ProgramData") / "Engenharia/config.json"
  else:
    result = getEnv("ENGINEERING_CONFIG",getCurrentDir() / "config.json")
  for a in commandLineParams():
    if a.startsWith("--config="): result = a.substr(9)

proc main() =
  let c = loadConfig(configPath())
  let mac = primaryMac()
  let machine = sha256Hex(mac)
  if machine != c.macHash:
    raise newException(IOError, "O MAC atual não corresponde à instalação.")
  let pat = decryptPat(c.secretPath,mac)
  ensureRepo(c,pat)

  var server = newAsyncHttpServer()
  proc handleRequest(req: Request) {.async.} =
    try:
      let p = req.url.path
      if p == "/api/health":
        var ready = false
        try:
          var h = newHttpClient(timeout = 3000); defer: h.close
          ready = h.get(c.liteRtUrl & "/v1/models").code == Http200
        except CatchableError: discard
        await req.respond(Http200,$(%*{"ok":true,"runtime":"nim",
          "storage":"github","repository":c.owner & "/" & c.repo,
          "machineId":machine,"model":c.modelAlias,"liteRtReady":ready}),
          jsonHeaders()); return
      if p == "/api/device/status":
        await req.respond(Http200,$(%*{"ip":req.hostname,
          "machineAddress":machine,"addressAvailable":true}),
          jsonHeaders()); return
      if p == "/api/user/me":
        await req.respond(Http200,$(%*{"registered":true,
          "name":c.displayName,"role":"Administrador","sector":"Engenharia",
          "ip":req.hostname,"mac":machine,"machineAddress":machine}),
          jsonHeaders()); return
      if p == "/api/user/list":
        await req.respond(Http200,$(%*[{"name":c.displayName,
          "role":"Administrador","sector":"Engenharia","mac":machine}]),
          jsonHeaders()); return
      if p in ["/api/permissions","/api/permissions/pending"]:
        await req.respond(Http200,"[]",jsonHeaders()); return
      if p in ["/api/permissions/request","/api/permissions/respond"]:
        await req.respond(Http200,$(%*{"success":true}),jsonHeaders()); return
      if p == "/api/documents" and req.reqMethod == HttpGet:
        await req.respond(Http200,$listDocs(c,pat),jsonHeaders()); return
      if p.startsWith("/api/documents/") and req.reqMethod == HttpGet:
        let f = getFile(c,pat,decodeUrl(p.substr(15)))
        if f.found:
          await req.respond(Http200,f.content,
            textHeaders("text/markdown; charset=utf-8"))
        else: await req.respond(Http404,"Não encontrado")
        return
      if p == "/api/upload" and req.reqMethod == HttpPost:
        let headerValue: string =
          req.headers.getOrDefault("X-Filename")
        let raw =
          if headerValue.len > 0:
            headerValue
          else:
            "documento.md"
        let name = raw.extractFilename
        if name.len == 0 or name.contains("..") or req.body.len > 25*1024*1024:
          await req.respond(Http400,$(%*{"success":false,
            "error":"Arquivo inválido ou maior que 25 MB."}),jsonHeaders())
          return
        let repoPath = if name.toLowerAscii.endsWith(".md"):
          "documents/" & name else: "uploads/" & name
        putFile(c,pat,repoPath,req.body,"Enviar arquivo pela aplicação")
        if not repoPath.startsWith("documents/"):
          putFile(c,pat,"documents/" & name.changeFileExt(".md"),
            "# " & name & "\n\nOriginal: `" & repoPath & "`.",
            "Indexar arquivo enviado")
        await req.respond(Http200,$(%*{"success":true,"path":repoPath}),
          jsonHeaders()); return
      if p == "/api/chat" and req.reqMethod == HttpPost:
        let q = parseJson(req.body){"question"}.getStr.strip
        if q.len == 0:
          await req.respond(Http400,$(%*{"error":"Pergunta obrigatória."}),
            jsonHeaders()); return
        let selected = contextFor(c,pat,q)
        let answer = callModel(c,q,selected.text)
        await req.respond(Http200,$(%*{"text":answer,
          "sources":selected.sources}),jsonHeaders()); return
      if p == "/api/tasks" and req.reqMethod == HttpGet:
        await req.respond(Http200,$readTasks(c,pat),jsonHeaders()); return
      if p == "/api/tasks" and req.reqMethod == HttpPost:
        let input = parseJson(req.body)
        let taskId = $int64(epochTime())
        let createdAt =
          now().utc.format("yyyy-MM-dd'T'HH:mm:ss'Z'")
        var tasks = readTasks(c, pat)

        tasks.add(%*{
          "id": taskId,
          "title": input{"title"}.getStr,
          "description": input{"description"}.getStr,
          "assigned_to_mac": input{"assignedToMac"}.getStr,
          "status": "pending",
          "created_at": createdAt
        })
        writeTasks(c,pat,tasks)
        await req.respond(Http200,$(%*{"success":true}),jsonHeaders()); return
      if p.startsWith("/api/tasks/") and p.endsWith("/status"):
        let parts = p.split('/')
        let id = if parts.len > 3: parts[3] else: ""
        let status = parseJson(req.body){"status"}.getStr
        var tasks = readTasks(c,pat)
        for task in tasks.mitems:
          if task{"id"}.getStr == id: task["status"] = %status
        writeTasks(c,pat,tasks)
        await req.respond(Http200,$(%*{"success":true}),jsonHeaders()); return
      if p.startsWith("/api/"):
        await req.respond(Http404,$(%*{"error":"Rota não encontrada."}),
          jsonHeaders()); return

      var rel = if p == "/": "index.html" else: decodeUrl(p).strip(chars={'/'})
      if rel.contains("..") or rel.contains('\\'):
        await req.respond(Http400,"Caminho inválido"); return
      var file = c.publicDir / rel
      if not fileExists(file): file = c.publicDir / "index.html"
      await req.respond(Http200,readFile(file),textHeaders(mime(file)))
    except CatchableError as e:
      stderr.writeLine("[Engenharia] ",e.msg)
      await req.respond(Http500,$(%*{"error":e.msg}),jsonHeaders())

  proc cb(req: Request) {.async, gcsafe.} =
    {.cast(gcsafe).}:
      await handleRequest(req)

  echo "Engenharia Nim em 0.0.0.0:",int(c.port)
  waitFor server.serve(c.port,cb,address = "0.0.0.0")

when isMainModule: main()
