$ErrorActionPreference = 'Stop'
$projectDirectory = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$nodeExecutable = (Get-Command node).Source
$logDirectory = Join-Path $projectDirectory '.local-logs'
New-Item -ItemType Directory -Path $logDirectory -Force | Out-Null

foreach ($service in @(
  @{ Name = 'api'; Port = 3001; Arguments = @('server/index.mjs') },
  @{ Name = 'web'; Port = 5173; Arguments = @('node_modules/vite/bin/vite.js') }
)) {
  $listener = Get-NetTCPConnection -LocalPort $service.Port -State Listen -ErrorAction SilentlyContinue
  if ($listener) {
    Write-Output "$($service.Name): port $($service.Port) is already listening; keeping the existing process."
    continue
  }
  $process = Start-Process -FilePath $nodeExecutable -ArgumentList $service.Arguments -WorkingDirectory $projectDirectory -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $logDirectory "$($service.Name).log") -RedirectStandardError (Join-Path $logDirectory "$($service.Name).error.log")
  Write-Output "$($service.Name): started PID $($process.Id)"
}

for ($attempt = 0; $attempt -lt 20; $attempt++) {
  try {
    $api = Invoke-RestMethod -Uri 'http://127.0.0.1:3001/api/health' -TimeoutSec 2
    $web = Invoke-WebRequest -Uri 'http://127.0.0.1:5173/' -UseBasicParsing -TimeoutSec 2
    if ($api.status -eq 'ok' -and $web.StatusCode -eq 200) {
      Write-Output 'Ready: http://127.0.0.1:5173/#dashboard'
      exit 0
    }
  } catch { Start-Sleep -Milliseconds 500 }
}
throw "Local services did not become ready. Check $logDirectory"
