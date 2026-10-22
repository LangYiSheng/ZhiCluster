param(
    [switch]$Runtime,
    [string]$BaseUrl = 'http://127.0.0.1:3000',
    [int]$TimeoutSeconds = 60
)

$ErrorActionPreference = 'Stop'
$workspaceRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$composeArgs = @('compose', '-f', (Join-Path $workspaceRoot 'compose.yaml'), '-f', (Join-Path $workspaceRoot 'compose.dev.yaml'))
$checks = [Collections.Generic.List[object]]::new()

function Assert-Check([bool]$Condition, [string]$Name) {
    if (-not $Condition) { throw "FAIL: $Name" }
    $checks.Add([ordered]@{ name = $Name; status = 'PASS' })
    Write-Host "PASS: $Name"
}

function Read-ComposeLogs {
    $output = & docker @composeArgs logs --no-color --tail 300 api worker 2>&1
    if ($LASTEXITCODE -ne 0) { throw 'Unable to read dev service logs' }
    return ($output -join "`n")
}

function Last-Match([string]$Text, [string]$Pattern) {
    $matchesFound = [regex]::Matches($Text, $Pattern)
    if ($matchesFound.Count -eq 0) { return '' }
    return $matchesFound[$matchesFound.Count - 1].Groups[1].Value.Trim()
}

function Wait-Ready {
    $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
    do {
        try {
            $response = Invoke-RestMethod -Uri "$($BaseUrl.TrimEnd('/'))/api/ready" -TimeoutSec 5
            if ($response.status -eq 'ready') { return }
        }
        catch { }
        Start-Sleep -Milliseconds 500
    } while ([DateTime]::UtcNow -lt $deadline)
    throw 'API readiness timed out'
}

Push-Location $workspaceRoot
try {
    $rawConfig = & docker @composeArgs config --format json 2>&1
    if ($LASTEXITCODE -ne 0) { throw 'Compose development configuration failed to resolve' }
    $config = ($rawConfig -join "`n") | ConvertFrom-Json
    Assert-Check (($config.services.api.command -join ' ') -match '--reload') 'FastAPI reload command'
    Assert-Check (($config.services.worker.command -join ' ') -match 'watchfiles.*python -m app.worker.main.*/app/app') 'Worker watchfiles command'
    Assert-Check ($config.services.worker.build.dockerfile -eq 'Dockerfile.dev') 'Worker development dependency image'
    Assert-Check ($config.services.web.build.dockerfile -eq 'Dockerfile.dev') 'Vite development image'
    foreach ($serviceName in @('api', 'worker')) {
        $mounts = @($config.services.$serviceName.volumes | Where-Object { $_.type -eq 'bind' -and $_.target -eq '/app/app' })
        Assert-Check ($mounts.Count -eq 1 -and [IO.Path]::GetFullPath($mounts[0].source) -eq (Join-Path $workspaceRoot 'backend/app')) "$serviceName Python source bind mount"
    }
    foreach ($directory in @('src', 'public')) {
        $mounts = @($config.services.web.volumes | Where-Object { $_.type -eq 'bind' -and $_.target -eq "/app/$directory" })
        Assert-Check ($mounts.Count -eq 1 -and [IO.Path]::GetFullPath($mounts[0].source) -eq (Join-Path $workspaceRoot "frontend/$directory")) "Vite $directory bind mount"
    }
    $webPorts = @($config.services.web.ports)
    Assert-Check ($webPorts.Count -eq 1 -and $webPorts[0].target -eq 5173 -and $webPorts[0].published -eq '3000') 'Vite port replaces production port'
    $allPorts = @($config.services.PSObject.Properties | ForEach-Object { $_.Value.ports })
    Assert-Check (@($allPorts | Where-Object { $_ -and $_.host_ip -ne '127.0.0.1' }).Count -eq 0) 'All published ports bind loopback'
    $webDockerfile = Get-Content -LiteralPath (Join-Path $workspaceRoot 'frontend/Dockerfile.dev') -Raw
    Assert-Check ($webDockerfile -match 'VITE_API_PROXY=http://api:8000') 'Container Vite proxy targets API service'
    if (-not $Runtime) {
        [ordered]@{ mode = 'config-only'; checks = $checks; runtime = 'NOT_RUN'; note = 'No services started/stopped and no source files changed.' } | ConvertTo-Json -Depth 5
        return
    }

    Wait-Ready
    Assert-Check $true 'API ready through development web proxy'
    $viteClient = Invoke-WebRequest -Uri "$($BaseUrl.TrimEnd('/'))/@vite/client" -TimeoutSec 10
    Assert-Check ($viteClient.Content -match 'vite|WebSocket') 'Vite client is served'

    # Playwright observes a CSS update while a window sentinel remains alive.
    # A full browser reload cannot satisfy both conditions. The marker is removed
    # from the current file in finally, preserving unrelated concurrent edits.
    $frontendProbe = @'
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
const workspace = process.argv[2];
const baseUrl = process.argv[3];
const require = createRequire(path.join(workspace, 'frontend/package.json'));
const { chromium } = require('@playwright/test');
const stylePath = path.join(workspace, 'frontend/src/styles.css');
const marker = `zc-hmr-${Date.now()}`;
const block = `\n/* ${marker} begin */\n:root { --zhicluster-dev-probe: ${marker}; }\n/* ${marker} end */\n`;
const browser = await chromium.launch({ headless: true, channel: 'chromium' });
const page = await browser.newPage();
try {
  let connectionTimer;
  const connected = new Promise((resolve, reject) => {
    connectionTimer = setTimeout(() => reject(new Error('Vite HMR WebSocket did not connect')), 20000);
    page.on('websocket', socket => socket.on('framereceived', event => {
      try { if (JSON.parse(String(event.payload)).type === 'connected') resolve(); } catch {}
    }));
  });
  await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });
  await connected;
  clearTimeout(connectionTimer);
  await page.evaluate(value => { window.__zhiclusterDevSentinel = value; }, marker);
  fs.appendFileSync(stylePath, block, 'utf8');
  await page.waitForFunction(value => getComputedStyle(document.documentElement).getPropertyValue('--zhicluster-dev-probe').trim() === value && window.__zhiclusterDevSentinel === value, marker, { timeout: 30000 });
  console.log(JSON.stringify({ name: 'Vite CSS HMR without browser reload', status: 'PASS' }));
} finally {
  const current = fs.readFileSync(stylePath, 'utf8');
  if (current.includes(block)) fs.writeFileSync(stylePath, current.replace(block, ''), 'utf8');
  await browser.close();
}
'@
    $probeResult = $frontendProbe | & node --input-type=module - $workspaceRoot $BaseUrl
    if ($LASTEXITCODE -ne 0) { throw 'Browser HMR verification failed' }
    Assert-Check (($probeResult -join "`n") -match '"status":"PASS"') 'Vite CSS HMR without browser reload'

    $beforeLogs = Read-ComposeLogs
    $beforeApi = Last-Match $beforeLogs 'Started server process \[(\d+)\]'
    $beforeWorker = Last-Match $beforeLogs 'Worker started:\s*([^\r\n]+)'
    Assert-Check ([bool]$beforeApi -and [bool]$beforeWorker) 'API and worker process identities observable'
    $probeName = '_dev_reload_probe_' + [guid]::NewGuid().ToString('N') + '.py'
    $pythonProbe = [IO.Path]::GetFullPath((Join-Path $workspaceRoot "backend/app/$probeName"))
    Assert-Check ($pythonProbe.StartsWith((Join-Path $workspaceRoot 'backend/app'), [StringComparison]::OrdinalIgnoreCase) -and -not (Test-Path -LiteralPath $pythonProbe)) 'Temporary Python probe stays inside source directory'
    try {
        [IO.File]::WriteAllText($pythonProbe, "# Temporary source-watch probe; never imported.`n", [Text.UTF8Encoding]::new($false))
        $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
        $apiReloaded = $false
        $workerReloaded = $false
        do {
            Start-Sleep -Milliseconds 1000
            $logs = Read-ComposeLogs
            $apiIdentity = Last-Match $logs 'Started server process \[(\d+)\]'
            $workerIdentity = Last-Match $logs 'Worker started:\s*([^\r\n]+)'
            $apiReloaded = [bool]$apiIdentity -and $apiIdentity -ne $beforeApi
            $workerReloaded = [bool]$workerIdentity -and $workerIdentity -ne $beforeWorker
        } while ((-not $apiReloaded -or -not $workerReloaded) -and [DateTime]::UtcNow -lt $deadline)
        Assert-Check $apiReloaded 'FastAPI source change starts a new server process'
        Assert-Check $workerReloaded 'Worker source change starts a new worker process'
        Wait-Ready
        Assert-Check $true 'API ready after source reload'
    }
    finally {
        if (Test-Path -LiteralPath $pythonProbe) { Remove-Item -LiteralPath $pythonProbe }
    }
    Wait-Ready
    [ordered]@{ mode = 'runtime'; checks = $checks; runtime = 'PASS'; source_probes = 'restored'; services = 'left running' } | ConvertTo-Json -Depth 5
}
finally {
    Pop-Location
}
