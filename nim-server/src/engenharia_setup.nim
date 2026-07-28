import std/[
  asyncdispatch,
  asynchttpserver,
  httpcore,
  json,
  os,
  osproc,
  strtabs,
  strutils,
  uri
]

type SetupConfig = object
  port: Port
  publicDir: string
  projectDir: string
  statePath: string
  logPath: string
  setupHelper: string
  activateHelper: string
  machineId: string
  machineMac: string
  repositoryName: string
  mainConfigPath: string
  secretPath: string
  litertDir: string
  litertBin: string
  litertUrl: string
  modelRepository: string
  modelFile: string
  modelAlias: string

var setupProcess: Process = nil

proc jsonHeaders(): HttpHeaders =
  newHttpHeaders([
    ("Content-Type", "application/json; charset=utf-8"),
    ("Cache-Control", "no-store"),
    ("X-Content-Type-Options", "nosniff"),
    ("X-Frame-Options", "DENY"),
    ("Referrer-Policy", "no-referrer")
  ])

proc textHeaders(kind: string): HttpHeaders =
  newHttpHeaders([
    ("Content-Type", kind),
    ("Cache-Control", "no-store"),
    ("X-Content-Type-Options", "nosniff")
  ])

proc loadConfig(path: string): SetupConfig =
  let node = parseFile(path)

  result.port = Port(node{"port"}.getInt(3001))
  result.publicDir = node{"publicDir"}.getStr
  result.projectDir = node{"projectDir"}.getStr
  result.statePath = node{"statePath"}.getStr
  result.logPath = node{"logPath"}.getStr
  result.setupHelper = node{"setupHelper"}.getStr
  result.activateHelper = node{"activateHelper"}.getStr
  result.machineId = node{"machineId"}.getStr
  result.machineMac = node{"machineMac"}.getStr
  result.repositoryName =
    node{"repositoryName"}.getStr("engenharia-data")
  result.mainConfigPath = node{"mainConfigPath"}.getStr
  result.secretPath = node{"secretPath"}.getStr
  result.litertDir = node{"litertDir"}.getStr
  result.litertBin = node{"litertBin"}.getStr
  result.litertUrl =
    node{"litertUrl"}.getStr("http://127.0.0.1:9379")
  result.modelRepository = node{"modelRepository"}.getStr
  result.modelFile = node{"modelFile"}.getStr
  result.modelAlias = node{"modelAlias"}.getStr("gemma4-e2b")

proc defaultState(c: SetupConfig): JsonNode =
  %*{
    "runtime": "setup-nim",
    "setupRequired": true,
    "phase": "awaiting_credentials",
    "progress": 0,
    "message": "Informe as credenciais na interface.",
    "machineId": c.machineId,
    "repositoryName": c.repositoryName,
    "logTail": ""
  }

proc readLogTail(path: string, maximum = 6000): string =
  if not fileExists(path):
    return ""

  let content = readFile(path)

  if content.len <= maximum:
    return content

  content[content.len - maximum .. ^1]

proc readState(c: SetupConfig): JsonNode =
  if not fileExists(c.statePath):
    result = defaultState(c)
  else:
    try:
      result = parseFile(c.statePath)
    except CatchableError:
      result = defaultState(c)

  result["runtime"] = %"setup-nim"
  result["setupRequired"] = %true
  result["machineId"] = %c.machineId
  result["repositoryName"] =
    %result{"repositoryName"}.getStr(c.repositoryName)
  result["logTail"] = %readLogTail(c.logPath)

proc writeState(c: SetupConfig, state: JsonNode) =
  createDir(c.statePath.parentDir)
  writeFile(c.statePath, pretty(state) & "\n")

proc safeStaticPath(c: SetupConfig, requestPath: string): string =
  var relative =
    if requestPath == "/" or requestPath.len == 0:
      "index.html"
    else:
      decodeUrl(requestPath).strip(chars = {'/'})

  if relative.contains("..") or relative.contains('\\'):
    return ""

  result = c.publicDir / relative

  if not fileExists(result):
    result = c.publicDir / "index.html"

proc mimeType(path: string): string =
  case path.splitFile.ext.toLowerAscii
  of ".html": "text/html; charset=utf-8"
  of ".js": "text/javascript; charset=utf-8"
  of ".css": "text/css; charset=utf-8"
  of ".json": "application/json; charset=utf-8"
  of ".svg": "image/svg+xml"
  of ".png": "image/png"
  of ".jpg", ".jpeg": "image/jpeg"
  of ".ico": "image/x-icon"
  of ".wasm": "application/wasm"
  else: "application/octet-stream"

proc childEnvironment(
  c: SetupConfig,
  githubPat: string,
  repositoryName: string
): StringTableRef =
  result = newStringTable(modeCaseSensitive)

  for key, value in envPairs():
    result[key] = value

  result["GITHUB_PAT"] = githubPat
  result["REPOSITORY_NAME"] = repositoryName
  result["MACHINE_ID"] = c.machineId
  result["MACHINE_MAC"] = c.machineMac
  result["PROJECT_DIR"] = c.projectDir
  result["PUBLIC_DIR"] = c.publicDir
  result["STATE_PATH"] = c.statePath
  result["SETUP_LOG_PATH"] = c.logPath
  result["MAIN_CONFIG_PATH"] = c.mainConfigPath
  result["SECRET_PATH"] = c.secretPath
  result["LITERT_DIR"] = c.litertDir
  result["LITERT_BIN"] = c.litertBin
  result["LITERT_URL"] = c.litertUrl
  result["MODEL_REPOSITORY"] = c.modelRepository
  result["MODEL_FILE"] = c.modelFile
  result["MODEL_ALIAS"] = c.modelAlias

proc startConfiguration(
  c: SetupConfig,
  githubPat: string,
  repositoryName: string
) =
  if setupProcess != nil and running(setupProcess):
    raise newException(
      IOError,
      "Uma configuração já está em andamento."
    )

  let state = %*{
    "runtime": "setup-nim",
    "setupRequired": true,
    "phase": "validating_github",
    "progress": 5,
    "message": "Validando o Personal Access Token...",
    "machineId": c.machineId,
    "repositoryName": repositoryName
  }

  writeState(c, state)

  setupProcess = startProcess(
    c.setupHelper,
    workingDir = c.projectDir,
    env = childEnvironment(
      c,
      githubPat,
      repositoryName
    ),
    options = {poUsePath, poParentStreams}
  )

proc activateMain(c: SetupConfig) =
  let state = readState(c)

  if state{"phase"}.getStr != "ready":
    raise newException(
      IOError,
      "A configuração ainda não está pronta para ativação."
    )

  discard startProcess(
    "systemd-run",
    args = [
      "--user",
      "--unit=engenharia-activate",
      "--collect",
      c.activateHelper
    ],
    options = {poUsePath, poParentStreams}
  )

  state["phase"] = %"activating"
  state["progress"] = %100
  state["message"] =
    %"Transferindo a porta para EngenhariaNimServer..."
  writeState(c, state)

proc respondJson(
  req: Request,
  code: HttpCode,
  node: JsonNode
) {.async.} =
  await req.respond(code, $node, jsonHeaders())

proc configPath(): string =
  result = getEnv(
    "ENGINEERING_SETUP_CONFIG",
    getCurrentDir() / "setup-config.json"
  )

  for argument in commandLineParams():
    if argument.startsWith("--config="):
      result = argument.substr("--config=".len)

proc main() =
  let c = loadConfig(configPath())
  createDir(c.statePath.parentDir)
  createDir(c.logPath.parentDir)

  if not fileExists(c.statePath):
    writeState(c, defaultState(c))

  var server = newAsyncHttpServer()

  proc handleRequest(req: Request) {.async.} =
    try:
      let path = req.url.path

      if path == "/api/setup/status" and
          req.reqMethod == HttpGet:
        await respondJson(req, Http200, readState(c))
        return

      if path == "/api/setup/configure" and
          req.reqMethod == HttpPost:
        if req.body.len > 32 * 1024:
          await respondJson(req, Http413, %*{
            "error": "Requisição de configuração excessiva."
          })
          return

        let input = parseJson(req.body)
        let githubPat =
          input{"githubPat"}.getStr.strip
        let repositoryName =
          input{"repositoryName"}.getStr.strip

        if githubPat.len < 20:
          await respondJson(req, Http400, %*{
            "error": "Informe um PAT do GitHub válido."
          })
          return

        if repositoryName.len == 0 or
            repositoryName.len > 100:
          await respondJson(req, Http400, %*{
            "error": "Nome de repositório inválido."
          })
          return

        for ch in repositoryName:
          if not (
            ch.isAlphaNumeric or
            ch in {'-', '_', '.'}
          ):
            await respondJson(req, Http400, %*{
              "error": "O repositório contém caracteres inválidos."
            })
            return

        startConfiguration(
          c,
          githubPat,
          repositoryName
        )

        await respondJson(req, Http202, readState(c))
        return

      if path == "/api/setup/activate" and
          req.reqMethod == HttpPost:
        activateMain(c)
        await respondJson(req, Http202, %*{
          "success": true,
          "message": "Ativação iniciada."
        })
        return

      if path == "/api/health":
        let state = readState(c)
        await respondJson(req, Http200, %*{
          "ok": true,
          "runtime": "setup-nim",
          "setupRequired": true,
          "phase": state{"phase"}.getStr,
          "machineId": c.machineId
        })
        return

      if path.startsWith("/api/"):
        await respondJson(req, Http503, %*{
          "error": "Conclua a configuração inicial na interface.",
          "runtime": "setup-nim",
          "setupRequired": true
        })
        return

      let filePath = safeStaticPath(c, path)

      if filePath.len == 0 or not fileExists(filePath):
        await req.respond(
          Http404,
          "Arquivo não encontrado.",
          textHeaders("text/plain; charset=utf-8")
        )
        return

      await req.respond(
        Http200,
        readFile(filePath),
        textHeaders(mimeType(filePath))
      )
    except CatchableError as error:
      stderr.writeLine("[Setup Nim] ", error.msg)
      await respondJson(req, Http500, %*{
        "error": error.msg
      })

  proc callback(req: Request) {.async, gcsafe.} =
    {.cast(gcsafe).}:
      await handleRequest(req)

  echo "Engenharia Setup Nim em http://127.0.0.1:", int(c.port)
  waitFor server.serve(
    c.port,
    callback,
    address = "127.0.0.1"
  )

when isMainModule:
  main()
