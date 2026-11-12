# 미믹 CLI 설치(Windows PowerShell): irm <미믹 서버>/api/integrations/cli/install.ps1 | iex
$ErrorActionPreference = 'Stop'
$Server = if ($env:MIMIC_SERVER) { $env:MIMIC_SERVER } else { '__MIMIC_SERVER__' }
if ($Server.StartsWith('__')) { $Server = 'http://localhost:4300' }
$Dir = Join-Path $env:LOCALAPPDATA 'Mimic\cli'

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  Write-Error 'Node.js 20 이상이 필요합니다. https://nodejs.org 에서 설치하거나 "winget install OpenJS.NodeJS.LTS" 를 실행하세요.'
}
# node 인자에 큰따옴표를 넣지 않는다: Windows PowerShell 5.1 은 외부 명령 인자 안의 큰따옴표를 지운다
$major = [int]((node -v).TrimStart('v').Split('.')[0])
if ($major -lt 20) { Write-Error "Node.js 20 이상이 필요합니다(현재 $(node -v))." }

New-Item -ItemType Directory -Force -Path $Dir | Out-Null
Invoke-WebRequest "$Server/api/integrations/cli/mimic.js" -OutFile (Join-Path $Dir 'mimic.js') -UseBasicParsing
Invoke-WebRequest "$Server/api/integrations/cli/package.json" -OutFile (Join-Path $Dir 'package.json') -UseBasicParsing
Set-Content -Path (Join-Path $Dir 'mimic.cmd') -Encoding ASCII -Value "@echo off`r`nif not defined MIMIC_SERVER set MIMIC_SERVER=$Server`r`nnode `"%~dp0mimic.js`" %*"

$userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
if (-not ($userPath -split ';' | Where-Object { $_ -eq $Dir })) {
  [Environment]::SetEnvironmentVariable('Path', "$userPath;$Dir", 'User')
  Write-Host "PATH 에 $Dir 을 추가했습니다. 새 터미널을 여세요."
}
Write-Host "미믹 CLI 를 설치했습니다. 다음 단계: mimic auth login"
