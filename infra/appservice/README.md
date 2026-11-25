# Azure App Service (Linux) Deployment — Shared Enterprise Infra & Customer `.ZIP` Kit

Configuration Vault (`armbackup`) runs natively on a single **Azure App Service (Linux)** Web App with **Azure Blob Storage** and **Azure Key Vault** — sharing the exact same enterprise hosting resources (`asp-az01-stg-cloudwiz-msp-web-01`, `staz01stgcloudwizmsp01`, `kv-az01-stg-cloudwiz-msp`, `law-az01-stg-cloudwiz-msp`, and `sbn-az01-og084902-cloudwiz-msp-pe`) as `azfirewallagent` without any container, secret, or Private Endpoint collisions.

---

## Files in `infra/appservice/`

| File | Purpose |
| --- | --- |
| `Build-Package.ps1` / `build-package.sh` / `build-zip.bat` | Cross-platform builders creating `artifacts/appservice/armbackup.zip` (bundled Linux `manylinux` wheels + app + `startup.sh` + `.sha256`), pre-compiling `azuredeploy.json`, and producing `artifacts/appservice/armbackup-customer-kit.zip` (`-IncludeDeployKit` / `--include-deploy-kit`). |
| `Deploy-AppService.ps1` / `deploy-appservice.sh` | Declarative PowerShell / Bash deployment scripts supporting zero-argument `./deploy.config.json` execution, 3-stage App Service network lifecycle (`Disabled` on initial creation → `Enabled from select virtual networks and IP addresses` with `211.47.20.25/32`, `211.47.20.26/32` + `Unmatched=Deny` verified before `.ZIP` deployment), `Disabled`-only Storage enforcement, zero deployer Storage data-plane access, and Kudu direct streaming. |
| `deploy.config.example.json` | Single JSON configuration template pre-filled for the KT `stg-cloudwiz-msp` shared environment (`deploy.config.json`). |
| `CUSTOMER_DEPLOY_KO.md` | Korean step-by-step customer-site `.ZIP` deployment guide bundled inside `armbackup-customer-kit.zip`. |
| `azuredeploy.json` | Pre-compiled ARM JSON built from `main.bicep` so closed-network jumpboxes never need to download the `az bicep` binary. |
| `main.bicep` / `shared-private-endpoints.bicep` / `private-network.bicep` / `storage-setup.bicep` / `keyvault-setup.bicep` / `main.bicepparam` | Declarative Bicep templates for shared-infra or standalone App Service + Private Endpoints + Log Analytics diagnostic settings + OAuth Blob Storage + RBAC Key Vault provisioning. |
| `startup.sh` | Linux startup script running single-process `armbackup.webui` + in-process `SnapshotScheduler` & `BackupScheduler`. |
| `Setup-GitHubActions.ps1` | One-time OIDC Managed Identity + GitHub repository variable bootstrapper for developer subscriptions. |

---

## Build Customer Delivery Kit

```powershell
.\infra\appservice\Build-Package.ps1 -PythonVersion 3.12 -IncludeDeployKit
```

```bash
./infra/appservice/build-package.sh --python-version 3.12 --include-deploy-kit
```

Produces `artifacts/appservice/armbackup-customer-kit.zip` containing `armbackup.zip`, `armbackup.zip.sha256`, `azuredeploy.json`, `Deploy-AppService.ps1`, `deploy-appservice.sh`, `deploy.config.example.json`, Bicep sources, and `CUSTOMER_DEPLOY_KO.md`.

---

## Deploy at Customer Site (Zero CLI Flags)

```powershell
Copy-Item .\deploy.config.example.json .\deploy.config.json
.\Deploy-AppService.ps1
```

```bash
cp ./deploy.config.example.json ./deploy.config.json
chmod +x deploy-appservice.sh && ./deploy-appservice.sh
```

For a dry-run preview without modifying Azure resources, pass `-WhatIfPreview` (PowerShell) or `--what-if` (Bash).
