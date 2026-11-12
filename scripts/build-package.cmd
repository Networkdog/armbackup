@echo off
rem Builds the deploy bundle for a customer: armbackup-deploy.zip + deploy-customer.ps1 + SHA256.txt.
rem Run on the development PC (needs this repository, Python 3.12+ and optionally git).
rem
rem   scripts\build-package.cmd <deploy-config.json> [output-folder]
rem
rem <deploy-config.json> holds the non-secret "console" and "capture" sections (see docs\customer-deployment.md,
rem section 4). Never put secrets in it: its contents are packaged into the zip.
setlocal EnableExtensions DisableDelayedExpansion

if "%~1"=="" (
  echo Usage: %~nx0 ^<deploy-config.json^> [output-folder]
  exit /b 2
)
if not exist "%~f1" (
  echo ERROR: config file not found: %~f1
  exit /b 2
)
set "CONFIG=%~f1"

pushd "%~dp0.." || exit /b 1
set "ROOT=%CD%"
if "%~2"=="" (set "OUTROOT=%ROOT%\dist") else (set "OUTROOT=%~f2")

set "PY=%ROOT%\.venv\Scripts\python.exe"
if not exist "%PY%" set "PY=python"
"%PY%" -c "import sys; sys.exit(0 if sys.version_info >= (3, 12) else 1)" >nul 2>&1
if errorlevel 1 (
  echo ERROR: Python 3.12 or newer was not found. Install it or create .venv in %ROOT%.
  popd
  exit /b 1
)

rem The commit lets the deploy script confirm that the app serves exactly this build.
set "SHA="
set "DIRTY="
for /f "delims=" %%i in ('git rev-parse HEAD 2^>nul') do set "SHA=%%i"
if defined SHA (
  for /f "delims=" %%i in ('git status --porcelain -- src requirements.txt pyproject.toml 2^>nul') do set "DIRTY=1"
)
if defined SHA (
  set "LABEL=%SHA:~0,7%"
) else (
  set "LABEL=nogit"
  echo WARNING: git is not available; the package will not carry a build commit.
)
if defined DIRTY (
  set "LABEL=%LABEL%-dirty"
  echo WARNING: uncommitted changes in src\ are included, so the zip does not match commit %SHA:~0,7% exactly.
)

set "OUT=%OUTROOT%\armbackup-%LABEL%"
if not exist "%OUT%" mkdir "%OUT%"
if exist "%OUT%\armbackup-deploy.zip" del /q "%OUT%\armbackup-deploy.zip"
if exist "%OUT%\deploy-customer.ps1" del /q "%OUT%\deploy-customer.ps1"
if exist "%OUT%\SHA256.txt" del /q "%OUT%\SHA256.txt"

set "BUILD_ARG="
if defined SHA set "BUILD_ARG=--build %SHA%"
"%PY%" "%ROOT%\scripts\package_appservice.py" --config "%CONFIG%" %BUILD_ARG% --output "%OUT%\armbackup-deploy.zip"
if errorlevel 1 (
  echo ERROR: packaging failed.
  popd
  exit /b 1
)
copy /y "%ROOT%\scripts\deploy-customer.ps1" "%OUT%\deploy-customer.ps1" >nul
if errorlevel 1 (
  echo ERROR: could not copy deploy-customer.ps1.
  popd
  exit /b 1
)

set "HASH="
for /f "skip=1 delims=" %%h in ('certutil -hashfile "%OUT%\armbackup-deploy.zip" SHA256') do if not defined HASH set "HASH=%%h"
set "HASH=%HASH: =%"
if not defined HASH (
  echo ERROR: could not compute the SHA-256 of the zip.
  popd
  exit /b 1
)
> "%OUT%\SHA256.txt" echo %HASH%  armbackup-deploy.zip

echo.
echo Bundle ready: %OUT%
echo   armbackup-deploy.zip   (customer config inside; do not share with other customers)
echo   deploy-customer.ps1
echo   SHA256.txt             %HASH%
echo.
echo Copy the whole folder to the deployment PC, check the hash there, then run deploy-customer.ps1 -PackagePath .\armbackup-deploy.zip
popd
endlocal
exit /b 0
