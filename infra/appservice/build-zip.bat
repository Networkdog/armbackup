@echo off
rem Windows batch wrapper around Build-Package.ps1 for backward compatibility.
rem Usage: infra\appservice\build-zip.bat [output.zip] [--oryx-build] [--include-deploy-kit]
setlocal EnableExtensions

set "PS_ARGS="
:args
if "%~1"=="" goto run
if /I "%~1"=="--oryx-build" (
  set "PS_ARGS=%PS_ARGS% -OryxBuild"
) else if /I "%~1"=="--include-deploy-kit" (
  set "PS_ARGS=%PS_ARGS% -IncludeDeployKit"
) else (
  set "PS_ARGS=%PS_ARGS% -OutputPath ""%~f1"""
)
shift
goto args

:run
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0Build-Package.ps1" %PS_ARGS%
exit /b %ERRORLEVEL%
