<#
.SYNOPSIS
  Builds the Azure App Service deployment ZIP package and standalone customer delivery kit for Configuration Vault (armbackup).

.DESCRIPTION
  Produces artifacts\appservice\armbackup.zip containing:
    - src\armbackup (application backend + static UI modules + build-info.json)
    - pyproject.toml & README.md
    - startup.sh (LF-normalized Linux startup script running single-process console + snapshot/backup schedulers)
    - .python_packages\lib\site-packages (pre-downloaded Linux manylinux wheels when -OryxBuild is NOT set,
      eliminating remote Oryx build timeouts and outbound PyPI access requirements on private VNet App Services)

  When -IncludeDeployKit is passed, also pre-compiles main.bicep -> azuredeploy.json and produces
  artifacts\appservice\armbackup-customer-kit.zip for zero-dependency (`az` CLI only) customer deployment.

.EXAMPLE
  .\infra\appservice\Build-Package.ps1 -PythonVersion 3.12 -IncludeDeployKit
  .\infra\appservice\Build-Package.ps1 -OryxBuild
#>
[CmdletBinding()]
param(
  [string]$OutputPath = '',
  [ValidateSet('3.12', '3.13', '3.14')]
  [string]$PythonVersion = $(if ($env:PYTHON_VERSION) { $env:PYTHON_VERSION } else { '3.12' }),
  [string]$PythonExecutable = '',
  [switch]$OryxBuild,
  [switch]$IncludeDeployKit
)

$ErrorActionPreference = 'Stop'
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
if (-not $OutputPath) {
  $OutputPath = Join-Path $repoRoot 'artifacts\appservice\armbackup.zip'
} else {
  $OutputPath = [IO.Path]::GetFullPath($OutputPath)
}

function Resolve-Python311([string]$Explicit, [string]$Root) {
  $candidates = @()
  if ($Explicit) { $candidates += $Explicit }
  if ($env:PYTHON) { $candidates += $env:PYTHON }
  $venvPy = Join-Path $Root '.venv\Scripts\python.exe'
  if (Test-Path $venvPy) { $candidates += $venvPy }
  $candidates += @('python', 'python3')
  $azCliPy = 'C:\Program Files\Microsoft SDKs\Azure\CLI2\python.exe'
  if (Test-Path $azCliPy) { $candidates += $azCliPy }

  foreach ($cand in $candidates) {
    $previous = $ErrorActionPreference
    try {
      $ErrorActionPreference = 'Continue'
      $verOut = & $cand -c "import sys, tomllib; print(f'{sys.version_info.major}.{sys.version_info.minor}')" 2>$null
      if ($LASTEXITCODE -eq 0 -and $verOut) {
        return $cand
      }
    } catch {
    } finally {
      $ErrorActionPreference = $previous
    }
  }
  throw 'Python 3.11+ with pip was not found. Install Python 3.12+ or Azure CLI, or set -PythonExecutable.'
}

$PythonExecutable = Resolve-Python311 $PythonExecutable $repoRoot
$stageDir = Join-Path $repoRoot 'artifacts\appservice\stage'

Write-Host '[1/4] Staging application files...' -ForegroundColor Cyan
if (Test-Path $stageDir) { Remove-Item $stageDir -Recurse -Force }
New-Item -ItemType Directory -Path $stageDir -Force | Out-Null

Copy-Item (Join-Path $repoRoot 'pyproject.toml') (Join-Path $stageDir 'pyproject.toml') -Force
Copy-Item (Join-Path $repoRoot 'README.md') (Join-Path $stageDir 'README.md') -Force

$srcDir = Join-Path $repoRoot 'src\armbackup'
$stageSrcDir = Join-Path $stageDir 'src\armbackup'
New-Item -ItemType Directory -Path $stageSrcDir -Force | Out-Null
Get-ChildItem -Path $srcDir -Recurse -Force | Where-Object {
  $_.FullName -notmatch '(__pycache__|\.egg-info|\.pyc$|build-info\.json$)'
} | ForEach-Object {
  $rel = $_.FullName.Substring($srcDir.Length).TrimStart('\', '/')
  $dest = Join-Path $stageSrcDir $rel
  if ($_.PSIsContainer) {
    New-Item -ItemType Directory -Path $dest -Force | Out-Null
  } else {
    New-Item -ItemType Directory -Path (Split-Path $dest -Parent) -Force | Out-Null
    Copy-Item $_.FullName $dest -Force
  }
}

$startupSource = [IO.File]::ReadAllText((Join-Path $PSScriptRoot 'startup.sh')).Replace("`r`n", "`n").Replace("`r", "`n")
[IO.File]::WriteAllText((Join-Path $stageDir 'startup.sh'), $startupSource, (New-Object Text.UTF8Encoding($false)))

foreach ($seedCandidate in @((Join-Path $PSScriptRoot 'storage_seed'), (Join-Path $repoRoot 'storage_seed'))) {
  if (Test-Path $seedCandidate) {
    $stageSeed = Join-Path $stageDir 'storage_seed'
    Copy-Item $seedCandidate $stageSeed -Recurse -Force
    Write-Host "    Bundled startup Storage seed directory: $seedCandidate"
    break
  }
}

& $PythonExecutable -c "
import datetime, json, os, pathlib, subprocess, tomllib
root = pathlib.Path(r'$repoRoot')
stage = pathlib.Path(r'$stageDir')
ver = tomllib.loads((root / 'pyproject.toml').read_text(encoding='utf-8'))['project']['version']
sha = os.environ.get('GITHUB_SHA', '').strip().lower()
if not sha:
    try:
        sha = subprocess.check_output(['git', '-C', str(root), 'rev-parse', 'HEAD'], text=True, stderr=subprocess.DEVNULL).strip().lower()
    except Exception:
        sha = ''
run_no = os.environ.get('GITHUB_RUN_NUMBER', '').strip()
info = {
    'version': ver,
    'commit': sha if len(sha) >= 7 else '',
    'git_sha': sha[:12] if len(sha) >= 7 else '',
    'built_at': datetime.datetime.now(datetime.timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ'),
    'run_number': run_no if run_no.isdigit() else '',
}
(stage / 'src' / 'armbackup' / 'build-info.json').write_text(json.dumps(info) + '\n', encoding='utf-8')
"
if ($LASTEXITCODE -ne 0) { throw 'Failed to write build-info.json.' }

if (-not $OryxBuild) {
  Write-Host "[2/4] Bundling Linux manylinux wheels for Python $PythonVersion..." -ForegroundColor Cyan
  $depsFile = Join-Path $stageDir 'requirements-runtime.txt'
  Copy-Item (Join-Path $repoRoot 'requirements.txt') $depsFile -Force

  $targetPackages = Join-Path $stageDir '.python_packages\lib\site-packages'
  $pipExit = 1
  $previous = $ErrorActionPreference
  try {
    $ErrorActionPreference = 'Continue'
    & $PythonExecutable -m pip install --disable-pip-version-check --no-compile --quiet `
      --target $targetPackages `
      --platform manylinux2014_x86_64 `
      --platform manylinux_2_28_x86_64 `
      --implementation cp `
      --python-version $PythonVersion `
      --only-binary=:all: `
      -r $depsFile 2>$null
    $pipExit = $LASTEXITCODE
  } finally {
    $ErrorActionPreference = $previous
  }
  $cachedLinuxZip = Join-Path $repoRoot 'dist\armbackup-webjob.zip'
  if ($pipExit -ne 0 -and $PythonVersion -eq '3.12' -and (Test-Path $cachedLinuxZip)) {
    Write-Host '    PyPI unreachable; reusing verified offline Linux cp312 manylinux wheels from dist\armbackup-webjob.zip...' -ForegroundColor Yellow
    if (Test-Path $targetPackages) { Remove-Item $targetPackages -Recurse -Force }
    & $PythonExecutable -c "
import pathlib, zipfile
src = pathlib.Path(r'$cachedLinuxZip')
dst = pathlib.Path(r'$targetPackages')
prefix = 'App_Data/jobs/triggered/armbackup/.python_packages/lib/site-packages/'
with zipfile.ZipFile(src) as zf:
    for entry in zf.infolist():
        if entry.filename.startswith(prefix) and not entry.is_dir():
            rel = entry.filename[len(prefix):]
            out_file = dst / rel
            out_file.parent.mkdir(parents=True, exist_ok=True)
            out_file.write_bytes(zf.read(entry.filename))
"
    $pipExit = $LASTEXITCODE
  }
  if ($pipExit -ne 0) { throw "Failed to download Linux wheels for Python $PythonVersion." }
  $winBinDir = Join-Path $targetPackages 'bin'
  if (Test-Path $winBinDir) { Remove-Item $winBinDir -Recurse -Force }
  Remove-Item $depsFile -Force
} else {
  Write-Host '[2/4] Oryx remote build package selected (-OryxBuild): copying requirements.txt.' -ForegroundColor Cyan
  Copy-Item (Join-Path $repoRoot 'requirements.txt') (Join-Path $stageDir 'requirements.txt') -Force
}

Write-Host '[3/4] Writing forward-slash ZIP archive...' -ForegroundColor Cyan
$outDir = Split-Path $OutputPath -Parent
if (-not (Test-Path $outDir)) { New-Item -ItemType Directory -Path $outDir -Force | Out-Null }
if (Test-Path $OutputPath) { Remove-Item $OutputPath -Force }

& $PythonExecutable -c "
import pathlib, time, zipfile
stage = pathlib.Path(r'$stageDir')
out = pathlib.Path(r'$OutputPath')
now_utc = time.gmtime()[:6]
with zipfile.ZipFile(out, 'w', compression=zipfile.ZIP_DEFLATED) as zf:
    for item in sorted(stage.rglob('*')):
        if item.is_file():
            arcname = item.relative_to(stage).as_posix()
            info = zipfile.ZipInfo(arcname, date_time=now_utc)
            info.external_attr = (0o755 if arcname == 'startup.sh' else 0o644) << 16
            info.compress_type = zipfile.ZIP_DEFLATED
            zf.writestr(info, item.read_bytes())
"
if ($LASTEXITCODE -ne 0) { throw 'Failed to create ZIP archive.' }

Write-Host '[4/4] Cleaning temporary staging directory...' -ForegroundColor Cyan
Remove-Item $stageDir -Recurse -Force
$hashValue = (Get-FileHash -Path $OutputPath -Algorithm SHA256).Hash.ToLowerInvariant()
$shaFile = "$OutputPath.sha256"
$leafName = Split-Path $OutputPath -Leaf
[IO.File]::WriteAllText($shaFile, "$hashValue  $leafName`n", (New-Object Text.UTF8Encoding($false)))
$sizeMb = [math]::Round((Get-Item $OutputPath).Length / 1MB, 2)
Write-Host "Package ready: $OutputPath ($sizeMb MB, sha256=$($hashValue.Substring(0, 12))...)" -ForegroundColor Green

if ($IncludeDeployKit) {
  $bicepMain = Join-Path $PSScriptRoot 'main.bicep'
  $compiledArm = Join-Path $PSScriptRoot 'azuredeploy.json'
  if (Get-Command az -ErrorAction SilentlyContinue) {
    Write-Host '[4b/4] Pre-compiling main.bicep -> azuredeploy.json for offline customer deployment...' -ForegroundColor Cyan
    $previous = $ErrorActionPreference
    try {
      $ErrorActionPreference = 'Continue'
      & az bicep build --file $bicepMain --outfile $compiledArm 2>$null
      $bicepExit = $LASTEXITCODE
    } finally {
      $ErrorActionPreference = $previous
    }
    if ($bicepExit -ne 0 -and -not (Test-Path $compiledArm)) {
      throw 'Failed to compile main.bicep to azuredeploy.json.'
    }
  } elseif (-not (Test-Path $compiledArm)) {
    throw 'azuredeploy.json is missing and Azure CLI (az bicep) is unavailable to compile main.bicep.'
  }

  $kitZip = Join-Path (Split-Path $OutputPath -Parent) 'armbackup-customer-kit.zip'
  $kitStage = Join-Path (Split-Path $OutputPath -Parent) 'customer-kit-stage'
  if (Test-Path $kitStage) { Remove-Item $kitStage -Recurse -Force }
  New-Item -ItemType Directory -Path $kitStage -Force | Out-Null
  Copy-Item $OutputPath (Join-Path $kitStage 'armbackup.zip') -Force
  [IO.File]::WriteAllText((Join-Path $kitStage 'armbackup.zip.sha256'), "$hashValue  armbackup.zip`n", (New-Object Text.UTF8Encoding($false)))
  foreach ($kitFile in @(
    'Deploy-AppService.ps1',
    'deploy-appservice.sh',
    'deploy.config.example.json',
    'azuredeploy.json',
    'main.bicep',
    'main.bicepparam',
    'private-network.bicep',
    'shared-private-endpoints.bicep',
    'storage-setup.bicep',
    'keyvault-setup.bicep',
    'CUSTOMER_DEPLOY_KO.md'
  )) {
    $srcPath = Join-Path $PSScriptRoot $kitFile
    if ($kitFile.EndsWith('.sh')) {
      $lfContent = [IO.File]::ReadAllText($srcPath).Replace("`r`n", "`n").Replace("`r", "`n")
      [IO.File]::WriteAllText((Join-Path $kitStage $kitFile), $lfContent, (New-Object Text.UTF8Encoding($false)))
    } else {
      Copy-Item $srcPath (Join-Path $kitStage $kitFile) -Force
    }
  }
  if (Test-Path $kitZip) { Remove-Item $kitZip -Force }
  & $PythonExecutable -c "
import pathlib, time, zipfile
stage = pathlib.Path(r'$kitStage')
out = pathlib.Path(r'$kitZip')
now_utc = time.gmtime()[:6]
with zipfile.ZipFile(out, 'w', compression=zipfile.ZIP_DEFLATED) as zf:
    for item in sorted(stage.rglob('*')):
        if item.is_file():
            arcname = item.relative_to(stage).as_posix()
            info = zipfile.ZipInfo(arcname, date_time=now_utc)
            info.external_attr = (0o755 if arcname.endswith('.sh') else 0o644) << 16
            info.compress_type = zipfile.ZIP_DEFLATED
            zf.writestr(info, item.read_bytes())
"
  if ($LASTEXITCODE -ne 0) { throw 'Failed to create customer deployment kit ZIP.' }
  Remove-Item $kitStage -Recurse -Force
  Write-Host "Customer deployment kit ready: $kitZip" -ForegroundColor Green
}
