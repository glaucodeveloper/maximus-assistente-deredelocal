#Requires -RunAsAdministrator
[CmdletBinding()]
param(
    [string]$RepositoryName = "engenharia-data",
    [int]$Port = 3001,
    [string]$ModelAlias = "gemma4-e2b",
    [string]$ModelRepository = "litert-community/gemma-4-E2B-it-litert-lm",
    [string]$ModelFile = "gemma-4-E2B-it.litertlm"
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$InstallDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$DataDir = Join-Path $env:ProgramData "Engenharia"
$ConfigPath = Join-Path $DataDir "config.json"
$SecretPath = Join-Path $DataDir "github-pat.bin"
$Venv = Join-Path $DataDir "litert-venv"
$Logs = Join-Path $DataDir "logs"
New-Item -ItemType Directory -Force -Path $DataDir,$Logs | Out-Null

function Plain([Security.SecureString]$Value) {
    $ptr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($Value)
    try { [Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr) }
    finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr) }
}

function Primary-Mac {
    $adapter = Get-NetAdapter -Physical |
        Where-Object { $_.Status -eq "Up" -and $_.MacAddress } |
        Sort-Object ifIndex | Select-Object -First 1
    if (-not $adapter) {
        $adapter = Get-NetAdapter -Physical |
            Where-Object { $_.MacAddress } |
            Sort-Object ifIndex | Select-Object -First 1
    }
    if (-not $adapter) { throw "Nenhum MAC físico foi localizado." }
    ($adapter.MacAddress -replace "[^0-9A-Fa-f]","").ToUpperInvariant()
}

function Sha256([string]$Value) {
    $bytes = [Text.Encoding]::UTF8.GetBytes($Value)
    $hash = [Security.Cryptography.SHA256]::Create().ComputeHash($bytes)
    ([BitConverter]::ToString($hash)).Replace("-","").ToLowerInvariant()
}

$securePat = Read-Host "Personal Access Token GitHub (repo + contents)" -AsSecureString
$script:Pat = Plain $securePat
if ([string]::IsNullOrWhiteSpace($script:Pat)) { throw "PAT obrigatório." }

$headers = @{
    Authorization = "Bearer $script:Pat"
    Accept = "application/vnd.github+json"
    "X-GitHub-Api-Version" = "2022-11-28"
    "User-Agent" = "engenharia-installer/3.0"
}

function GH([string]$Method,[string]$Uri,[object]$Body=$null) {
    $args = @{ Method=$Method; Uri=$Uri; Headers=$headers; ErrorAction="Stop" }
    if ($null -ne $Body) {
        $args.ContentType = "application/json"
        $args.Body = $Body | ConvertTo-Json -Depth 20 -Compress
    }
    Invoke-RestMethod @args
}

function Get-RepoFile([string]$Owner,[string]$Repo,[string]$Path) {
    try { GH GET "https://api.github.com/repos/$Owner/$Repo/contents/$Path" }
    catch {
        if ($_.Exception.Response.StatusCode.value__ -eq 404) { return $null }
        throw
    }
}

function Set-RepoFile(
    [string]$Owner,[string]$Repo,[string]$Path,
    [string]$Content,[string]$Message
) {
    $old = Get-RepoFile $Owner $Repo $Path
    $body = @{
        message = $Message
        content = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($Content))
        branch = "main"
    }
    if ($old -and $old.sha) { $body.sha = $old.sha }
    GH PUT "https://api.github.com/repos/$Owner/$Repo/contents/$Path" $body |
        Out-Null
}

Write-Host "Validando GitHub..." -ForegroundColor Cyan
$user = GH GET "https://api.github.com/user"
$owner = $user.login

try { $repo = GH GET "https://api.github.com/repos/$owner/$RepositoryName" }
catch {
    if ($_.Exception.Response.StatusCode.value__ -ne 404) { throw }
    Write-Host "Criando repositório privado $owner/$RepositoryName..."
    $repo = GH POST "https://api.github.com/user/repos" @{
        name=$RepositoryName
        description="Dados privados da aplicação Engenharia"
        private=$true
        auto_init=$true
    }
    Start-Sleep 2
}
if (-not $repo.private) { throw "O repositório de dados precisa ser privado." }

$mac = Primary-Mac
$macHash = Sha256 $mac
$entropy = [Text.Encoding]::UTF8.GetBytes("EngenhariaData|$mac")
$cipher = [Security.Cryptography.ProtectedData]::Protect(
    [Text.Encoding]::UTF8.GetBytes($script:Pat),
    $entropy,
    [Security.Cryptography.DataProtectionScope]::LocalMachine
)
[IO.File]::WriteAllBytes($SecretPath,$cipher)

Set-RepoFile $owner $RepositoryName "state/tasks.json" "[]" "Inicializar atividades"
Set-RepoFile $owner $RepositoryName "documents/README.md" @"
# Engenharia Data

Repositório privado da aplicação Engenharia. O PAT não é armazenado aqui.
A máquina é vinculada por hash SHA-256 do MAC.
"@ "Inicializar documentos"

$machine = @{
    machineId=$macHash
    macHash=$macHash
    host=$env:COMPUTERNAME
    registeredAt=[DateTime]::UtcNow.ToString("o")
    rawMacStored=$false
} | ConvertTo-Json -Depth 10
Set-RepoFile $owner $RepositoryName "machines/$macHash.json" $machine `
    "Registrar servidor Engenharia"

$config = [ordered]@{
    port=$Port
    publicDir=(Join-Path $InstallDir "public")
    secretPath=$SecretPath
    githubOwner=$owner
    githubRepo=$RepositoryName
    githubBranch="main"
    macHash=$macHash
    litertBaseUrl="http://127.0.0.1:9379"
    modelAlias=$ModelAlias
    displayName=($(if ($user.name) { $user.name } else { $owner }))
}
$config | ConvertTo-Json -Depth 10 | Set-Content -Encoding UTF8 $ConfigPath

Write-Host "Instalando LiteRT-LM..." -ForegroundColor Cyan
$uv = Get-Command uv -ErrorAction SilentlyContinue
if (-not $uv) {
    if (-not (Get-Command winget -ErrorAction SilentlyContinue)) {
        throw "winget é necessário para instalar uv."
    }
    winget install --id astral-sh.uv -e `
        --accept-package-agreements --accept-source-agreements
    $env:Path = [Environment]::GetEnvironmentVariable("Path","Machine") + ";" +
        [Environment]::GetEnvironmentVariable("Path","User")
    $uv = Get-Command uv -ErrorAction Stop
}

& $uv.Source venv $Venv --python 3.13
$python = Join-Path $Venv "Scripts\python.exe"
$litert = Join-Path $Venv "Scripts\litert-lm.exe"
& $uv.Source pip install --python $python --upgrade "litert-lm>=0.13"

$secureHf = Read-Host "Token Hugging Face autorizado para Gemma 4" -AsSecureString
$hf = Plain $secureHf
if ([string]::IsNullOrWhiteSpace($hf)) { throw "Token Hugging Face obrigatório." }

$oldHf = $env:HUGGING_FACE_HUB_TOKEN
$env:HUGGING_FACE_HUB_TOKEN = $hf
try {
    & $litert import "--from-huggingface-repo=$ModelRepository" `
        $ModelFile $ModelAlias
}
finally {
    $env:HUGGING_FACE_HUB_TOKEN = $oldHf
    $hf = $null
    $script:Pat = $null
}

$serverExe = Join-Path $InstallDir "EngenhariaServer.exe"
$serverWrapper = Join-Path $InstallDir "EngenhariaServerService.exe"
$serverXml = Join-Path $InstallDir "EngenhariaServerService.xml"
$litertWrapper = Join-Path $InstallDir "LiteRTLMService.exe"
$litertXml = Join-Path $InstallDir "LiteRTLMService.xml"

@"
<service>
  <id>EngenhariaLiteRTLM</id>
  <name>Engenharia LiteRT-LM</name>
  <description>Gemma 4 E2B local.</description>
  <executable>$litert</executable>
  <arguments>serve --host 127.0.0.1 --port 9379</arguments>
  <workingdirectory>$DataDir</workingdirectory>
  <startmode>Automatic</startmode>
  <onfailure action="restart" delay="10 sec" />
  <logpath>$Logs</logpath><log mode="roll" />
</service>
"@ | Set-Content -Encoding UTF8 $litertXml

@"
<service>
  <id>EngenhariaNimServer</id>
  <name>Engenharia Nim Server</name>
  <description>Servidor local Nim e sincronização GitHub.</description>
  <executable>$serverExe</executable>
  <arguments>--config=$ConfigPath</arguments>
  <workingdirectory>$InstallDir</workingdirectory>
  <startmode>Automatic</startmode>
  <depend>EngenhariaLiteRTLM</depend>
  <onfailure action="restart" delay="10 sec" />
  <logpath>$Logs</logpath><log mode="roll" />
</service>
"@ | Set-Content -Encoding UTF8 $serverXml

foreach ($svc in @(
    @{Name="EngenhariaNimServer";Exe=$serverWrapper},
    @{Name="EngenhariaLiteRTLM";Exe=$litertWrapper}
)) {
    if (Get-Service $svc.Name -ErrorAction SilentlyContinue) {
        & $svc.Exe stop 2>$null
        & $svc.Exe uninstall 2>$null
    }
    & $svc.Exe install
}

& $litertWrapper start
Start-Sleep 3
& $serverWrapper start

$rule = "Engenharia Nim TCP $Port"
Get-NetFirewallRule -DisplayName $rule -ErrorAction SilentlyContinue |
    Remove-NetFirewallRule
New-NetFirewallRule -DisplayName $rule -Direction Inbound -Action Allow `
    -Protocol TCP -LocalPort $Port -Profile Private | Out-Null

Write-Host ""
Write-Host "Configuração concluída." -ForegroundColor Green
Write-Host "Repositório: $owner/$RepositoryName"
Write-Host "Máquina: $macHash"
Write-Host "Local: http://127.0.0.1:$Port"
Get-NetIPAddress -AddressFamily IPv4 |
    Where-Object { $_.IPAddress -notlike "127.*" -and
        $_.PrefixOrigin -ne "WellKnown" } |
    ForEach-Object { Write-Host "Rede: http://$($_.IPAddress):$Port" }
