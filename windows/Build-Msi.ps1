[CmdletBinding()]
param([string]$Version="3.0.0")

$ErrorActionPreference="Stop"
$Root=Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$Stage=Join-Path $Root "dist\windows-stage"
$Dist=Join-Path $Root "dist"

foreach($cmd in @("node","npm","nim","wix")){
    if(-not(Get-Command $cmd -ErrorAction SilentlyContinue)){
        throw "Comando obrigatório ausente: $cmd"
    }
}

Push-Location $Root
try{
    npm install
    npm run build:client
    Remove-Item -Recurse -Force $Stage -ErrorAction SilentlyContinue
    New-Item -ItemType Directory -Force -Path $Stage,$Dist | Out-Null

    nim c -d:release --opt:speed --threads:on --app:console `
      "-o:$(Join-Path $Stage 'EngenhariaServer.exe')" `
      (Join-Path $Root "nim-server\src\engenharia_server.nim")

    Copy-Item -Recurse -Force (Join-Path $Root "public") `
      (Join-Path $Stage "public")
    Copy-Item -Force (Join-Path $Root "windows\Configure-Engenharia.ps1") $Stage
    Copy-Item -Force (Join-Path $Root "windows\Configure-Engenharia.cmd") $Stage

    $winsw="https://github.com/winsw/winsw/releases/download/v2.12.0/WinSW-x64.exe"
    Invoke-WebRequest -UseBasicParsing $winsw `
      -OutFile (Join-Path $Stage "EngenhariaServerService.exe")
    Copy-Item (Join-Path $Stage "EngenhariaServerService.exe") `
      (Join-Path $Stage "LiteRTLMService.exe")

    @"
Após instalar o MSI, execute como administrador:
C:\Program Files\Engenharia\Configure-Engenharia.cmd
"@ | Set-Content -Encoding UTF8 (Join-Path $Stage "LEIA-ME.txt")

    wix build -arch x64 "-dStageDir=$Stage" "-dProductVersion=$Version" `
      -o (Join-Path $Dist "Engenharia-$Version-x64.msi") `
      (Join-Path $Root "windows\installer\Engenharia.wxs")

    Write-Host "MSI: $(Join-Path $Dist "Engenharia-$Version-x64.msi")" `
      -ForegroundColor Green
}
finally{ Pop-Location }
