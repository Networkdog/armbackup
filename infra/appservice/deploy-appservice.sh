#!/usr/bin/env bash
# Single-shot Bash deployment script for Configuration Vault (armbackup) on Azure App Service (Linux).
#
# Supports KT Landing Zone & enterprise shared infrastructure (existing Linux App Service Plan, Storage Account,
# Key Vault, Log Analytics Workspace, VNet integration subnet, and Private Endpoint subnet — shared cleanly alongside
# azfirewallagent) as well as standalone provisioning using pre-compiled azuredeploy.json.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [ -f "$HERE/../../pyproject.toml" ]; then
  ROOT="$(cd "$HERE/../.." && pwd)"
else
  ROOT=""
fi

CONFIG_FILE=""
NAME=""
RESOURCE_GROUP=""
LOCATION=""
SUBSCRIPTION_ID=""
TARGET_SUBSCRIPTION_ID=""
TARGET_SUBSCRIPTION_NAME=""
WORKSPACE_DISPLAY_NAME="KT"
RESTORE_ENABLED="false"
ACTIVITY_DAYS="2"
PYTHON_VERSION="3.12"
PLAN_SKU="P0v3"
EXISTING_PLAN_ID=""
EXISTING_STORAGE_ID=""
EXISTING_KV_ID=""
EXISTING_LAW_ID=""
STORAGE_NAMESPACE=""
STORAGE_CONTAINER_NAME=""
STORAGE_BLOB_PREFIX="armbackup"
WEBAPP_PUBLIC_ACCESS="Disabled"
ALLOWED_IP_CIDRS=""
VNET_SUBNET_ID=""
VNET_SUBNET_NAME=""
VNET_SUBNET_PREFIX=""
VNET_ROUTE_ALL="false"
PE_SUBNET_ID=""
PE_RESOURCE_GROUP=""
ENABLE_WEBAPP_PE="true"
CREATE_MISSING_SHARED_PES="true"
RESOURCE_SCOPED_RBAC="true"
AUTH_PROVIDER="password"
USE_KV_SECRET="false"
ADMIN_USERNAME="admin"
ADMIN_PASSWORD_HASH=""
ADMIN_PASSWORD=""
DEFAULT_ADMIN_PW_HASH="scrypt:32768:8:3:GSmKwboJ-5FG3tKFeVx-lw:-O1V3rvEVr7CDF6hyT9mJz3U5LjAYcjjRqJyBVFxdds"
LOG_WORKSPACE_GUID=""
LOG_DCR_ID=""
LOG_RULE_ID=""
LOG_ENDPOINT=""
LOG_STREAM=""
ORYX_BUILD=0
ROTATE_PASSWORD=0
SKIP_BUILD=0
ASSIGN_RBAC=0
SKIP_RBAC=0
WHAT_IF_ONLY=0
NO_WAIT_HEALTH=0
PACKAGE_PATH=""
PACKAGE_URI=""

while [ $# -gt 0 ]; do
  case "$1" in
    --config|-c) CONFIG_FILE="$2"; shift 2 ;;
    --name) NAME="$2"; shift 2 ;;
    --resource-group|-g) RESOURCE_GROUP="$2"; shift 2 ;;
    --location|-l) LOCATION="$2"; shift 2 ;;
    --subscription) SUBSCRIPTION_ID="$2"; shift 2 ;;
    --target-subscription) TARGET_SUBSCRIPTION_ID="$2"; shift 2 ;;
    --target-subscription-name) TARGET_SUBSCRIPTION_NAME="$2"; shift 2 ;;
    --workspace-name) WORKSPACE_DISPLAY_NAME="$2"; shift 2 ;;
    --enable-restore) RESTORE_ENABLED="true"; shift ;;
    --activity-days) ACTIVITY_DAYS="$2"; shift 2 ;;
    --python-version) PYTHON_VERSION="$2"; shift 2 ;;
    --sku) PLAN_SKU="$2"; shift 2 ;;
    --existing-plan-id|--app-service-plan) EXISTING_PLAN_ID="$2"; shift 2 ;;
    --existing-storage-id|--storage-account) EXISTING_STORAGE_ID="$2"; shift 2 ;;
    --existing-keyvault-id|--key-vault) EXISTING_KV_ID="$2"; shift 2 ;;
    --existing-log-analytics-id|--log-analytics-workspace) EXISTING_LAW_ID="$2"; shift 2 ;;
    --storage-namespace) STORAGE_NAMESPACE="$2"; shift 2 ;;
    --storage-container) STORAGE_CONTAINER_NAME="$2"; shift 2 ;;
    --storage-prefix) STORAGE_BLOB_PREFIX="$2"; shift 2 ;;
    --webapp-public-access) WEBAPP_PUBLIC_ACCESS="$2"; shift 2 ;;
    --allowed-ip-cidrs) ALLOWED_IP_CIDRS="$2"; shift 2 ;;
    --vnet-subnet-id) VNET_SUBNET_ID="$2"; shift 2 ;;
    --vnet-subnet-name) VNET_SUBNET_NAME="$2"; shift 2 ;;
    --vnet-subnet-prefix) VNET_SUBNET_PREFIX="$2"; shift 2 ;;
    --vnet-route-all) VNET_ROUTE_ALL="true"; shift ;;
    --pe-subnet-id) PE_SUBNET_ID="$2"; shift 2 ;;
    --pe-resource-group) PE_RESOURCE_GROUP="$2"; shift 2 ;;
    --disable-webapp-pe) ENABLE_WEBAPP_PE="false"; shift ;;
    --no-missing-shared-pes) CREATE_MISSING_SHARED_PES="false"; shift ;;
    --account-scoped-rbac) RESOURCE_SCOPED_RBAC="false"; shift ;;
    --auth-provider) AUTH_PROVIDER="$2"; shift 2 ;;
    --use-keyvault-secret) USE_KV_SECRET="true"; shift ;;
    --admin-username) ADMIN_USERNAME="$2"; shift 2 ;;
    --admin-password-hash) ADMIN_PASSWORD_HASH="$2"; shift 2 ;;
    --admin-password) ADMIN_PASSWORD="$2"; shift 2 ;;
    --rotate-admin-password) ROTATE_PASSWORD=1; shift ;;
    --log-workspace-guid) LOG_WORKSPACE_GUID="$2"; shift 2 ;;
    --log-dcr-id) LOG_DCR_ID="$2"; shift 2 ;;
    --log-rule-id) LOG_RULE_ID="$2"; shift 2 ;;
    --log-endpoint) LOG_ENDPOINT="$2"; shift 2 ;;
    --log-stream) LOG_STREAM="$2"; shift 2 ;;
    --oryx-build) ORYX_BUILD=1; shift ;;
    --skip-build) SKIP_BUILD=1; shift ;;
    --assign-rbac) ASSIGN_RBAC=1; shift ;;
    --skip-rbac) SKIP_RBAC=1; shift ;;
    --what-if) WHAT_IF_ONLY=1; shift ;;
    --no-wait-health) NO_WAIT_HEALTH=1; shift ;;
    --package) PACKAGE_PATH="$2"; shift 2 ;;
    --package-uri) PACKAGE_URI="$2"; shift 2 ;;
    --provision-infra) shift ;;
    *) echo "Unknown argument: $1" >&2; exit 2 ;;
  esac
done

if [ -z "$CONFIG_FILE" ] && [ -f "$HERE/deploy.config.json" ]; then
  CONFIG_FILE="$HERE/deploy.config.json"
fi

PY_HELPER=""
for candidate in python3 python /opt/az/bin/python3; do
  if command -v "$candidate" >/dev/null 2>&1; then
    PY_HELPER="$candidate"
    break
  fi
done

EXTRA_TAGS_JSON="{}"
if [ -n "$CONFIG_FILE" ]; then
  if [ ! -f "$CONFIG_FILE" ]; then
    echo "[ERROR] Config file not found: $CONFIG_FILE" >&2
    exit 2
  fi
  if [ -z "$PY_HELPER" ]; then
    echo "[ERROR] Reading $CONFIG_FILE requires python3 (normally bundled with Azure CLI)." >&2
    exit 2
  fi
  echo "==> Loading configuration from '$CONFIG_FILE'..."
  eval "$("$PY_HELPER" - "$CONFIG_FILE" <<'PY'
import json, re, shlex, sys
raw_lines = [ln for ln in open(sys.argv[1], encoding="utf-8").splitlines() if not re.match(r"^\s*//", ln)]
cfg = json.loads("\n".join(raw_lines))
def s(k, alt=""):
    v = cfg.get(k)
    if v in (None, "") and alt:
        v = cfg.get(alt)
    if isinstance(v, list):
        v = ",".join(str(x) for x in v if x)
    elif isinstance(v, bool):
        v = "true" if v else "false"
    return "" if v is None else str(v)

pairs = {
    "CFG_SUB": s("subscriptionId"),
    "CFG_RG": s("resourceGroup"),
    "CFG_LOC": s("location"),
    "CFG_NAME": s("webAppName", "name"),
    "CFG_PNA": s("webAppPublicNetworkAccess"),
    "CFG_ALLOWED_IPS": s("allowedIpCidrs"),
    "CFG_PY": s("pythonVersion"),
    "CFG_SKU": s("appServicePlanSku"),
    "CFG_PLAN": s("appServicePlan", "appServicePlanId"),
    "CFG_ST": s("storageAccount", "storageAccountName"),
    "CFG_KV": s("keyVault", "keyVaultName"),
    "CFG_LAW": s("logAnalyticsWorkspace", "logAnalyticsWorkspaceId"),
    "CFG_NS": s("storageNamespace"),
    "CFG_CNT": s("storageContainerName"),
    "CFG_PFX": s("storageBlobPrefix"),
    "CFG_WS_LABEL": s("workspaceDisplayName"),
    "CFG_TSUB": s("targetSubscriptionId"),
    "CFG_TSUB_NAME": s("targetSubscriptionName"),
    "CFG_RESTORE": s("restoreEnabled"),
    "CFG_DAYS": s("activityDays"),
    "CFG_VNET_SBN": s("vnetIntegrationSubnetId"),
    "CFG_VNET_SBN_NAME": s("vnetIntegrationSubnetName"),
    "CFG_VNET_SBN_PFX": s("vnetIntegrationSubnetPrefix"),
    "CFG_VNET_ROUTE_ALL": s("vnetRouteAllEnabled"),
    "CFG_PE_SBN": s("privateEndpointSubnetId"),
    "CFG_PE_RG": s("privateEndpointResourceGroup"),
    "CFG_WEB_PE": s("enableWebAppPrivateEndpoint"),
    "CFG_SHARED_PE": s("createMissingSharedPrivateEndpoints"),
    "CFG_SCOPED_RBAC": s("resourceScopedDataPlaneRbac"),
    "CFG_AUTH": s("authProvider"),
    "CFG_USE_KV": s("useKeyVaultSecret"),
    "CFG_USER": s("adminUsername"),
    "CFG_PW_HASH": s("adminPasswordHash"),
    "CFG_LOG_GUID": s("logWorkspaceGuid"),
    "CFG_LOG_DCR": s("logDcrId"),
    "CFG_LOG_RULE": s("logRuleId"),
    "CFG_LOG_EP": s("logEndpoint"),
    "CFG_LOG_STREAM": s("logStream"),
    "CFG_ASSIGN_RBAC": s("assignRoleAssignments"),
    "CFG_SKIP_RBAC": s("skipRoleAssignments"),
    "CFG_PKG": s("packagePath"),
    "CFG_PKG_URI": s("packageUri"),
    "CFG_TAGS_JSON": json.dumps({k: v for k, v in (cfg.get("tags") or {}).items() if not str(k).startswith("_")}),
}
for k, v in pairs.items():
    print(f"{k}={shlex.quote(v)}")
PY
)"
  [ -z "$SUBSCRIPTION_ID" ] && SUBSCRIPTION_ID="$CFG_SUB"
  [ -z "$RESOURCE_GROUP" ] && RESOURCE_GROUP="$CFG_RG"
  [ -z "$LOCATION" ] && LOCATION="$CFG_LOC"
  [ -z "$NAME" ] && NAME="$CFG_NAME"
  [ -n "$CFG_PNA" ] && [ "$WEBAPP_PUBLIC_ACCESS" = "Disabled" ] && WEBAPP_PUBLIC_ACCESS="$CFG_PNA"
  [ -z "$ALLOWED_IP_CIDRS" ] && ALLOWED_IP_CIDRS="$CFG_ALLOWED_IPS"
  [ -n "$CFG_PY" ] && PYTHON_VERSION="$CFG_PY"
  [ -n "$CFG_SKU" ] && PLAN_SKU="$CFG_SKU"
  [ -z "$EXISTING_PLAN_ID" ] && EXISTING_PLAN_ID="$CFG_PLAN"
  [ -z "$EXISTING_STORAGE_ID" ] && EXISTING_STORAGE_ID="$CFG_ST"
  [ -z "$EXISTING_KV_ID" ] && EXISTING_KV_ID="$CFG_KV"
  [ -z "$EXISTING_LAW_ID" ] && EXISTING_LAW_ID="$CFG_LAW"
  [ -z "$STORAGE_NAMESPACE" ] && STORAGE_NAMESPACE="$CFG_NS"
  [ -z "$STORAGE_CONTAINER_NAME" ] && STORAGE_CONTAINER_NAME="$CFG_CNT"
  [ -n "$CFG_PFX" ] && STORAGE_BLOB_PREFIX="$CFG_PFX"
  [ -n "$CFG_WS_LABEL" ] && WORKSPACE_DISPLAY_NAME="$CFG_WS_LABEL"
  [ -z "$TARGET_SUBSCRIPTION_ID" ] && TARGET_SUBSCRIPTION_ID="$CFG_TSUB"
  [ -z "$TARGET_SUBSCRIPTION_NAME" ] && TARGET_SUBSCRIPTION_NAME="$CFG_TSUB_NAME"
  [ -n "$CFG_RESTORE" ] && RESTORE_ENABLED="$CFG_RESTORE"
  [ -n "$CFG_DAYS" ] && ACTIVITY_DAYS="$CFG_DAYS"
  [ -z "$VNET_SUBNET_ID" ] && VNET_SUBNET_ID="$CFG_VNET_SBN"
  [ -z "$VNET_SUBNET_NAME" ] && VNET_SUBNET_NAME="$CFG_VNET_SBN_NAME"
  [ -z "$VNET_SUBNET_PREFIX" ] && VNET_SUBNET_PREFIX="$CFG_VNET_SBN_PFX"
  [ -n "$CFG_VNET_ROUTE_ALL" ] && VNET_ROUTE_ALL="$CFG_VNET_ROUTE_ALL"
  [ -z "$PE_SUBNET_ID" ] && PE_SUBNET_ID="$CFG_PE_SBN"
  [ -z "$PE_RESOURCE_GROUP" ] && PE_RESOURCE_GROUP="$CFG_PE_RG"
  [ -n "$CFG_WEB_PE" ] && ENABLE_WEBAPP_PE="$CFG_WEB_PE"
  [ -n "$CFG_SHARED_PE" ] && CREATE_MISSING_SHARED_PES="$CFG_SHARED_PE"
  [ -n "$CFG_SCOPED_RBAC" ] && RESOURCE_SCOPED_RBAC="$CFG_SCOPED_RBAC"
  [ -n "$CFG_AUTH" ] && AUTH_PROVIDER="$CFG_AUTH"
  [ -n "$CFG_USE_KV" ] && USE_KV_SECRET="$CFG_USE_KV"
  [ -n "$CFG_USER" ] && ADMIN_USERNAME="$CFG_USER"
  [ -z "$ADMIN_PASSWORD_HASH" ] && ADMIN_PASSWORD_HASH="$CFG_PW_HASH"
  [ -z "$LOG_WORKSPACE_GUID" ] && LOG_WORKSPACE_GUID="$CFG_LOG_GUID"
  [ -z "$LOG_DCR_ID" ] && LOG_DCR_ID="$CFG_LOG_DCR"
  [ -z "$LOG_RULE_ID" ] && LOG_RULE_ID="$CFG_LOG_RULE"
  [ -z "$LOG_ENDPOINT" ] && LOG_ENDPOINT="$CFG_LOG_EP"
  [ -z "$LOG_STREAM" ] && LOG_STREAM="$CFG_LOG_STREAM"
  [ "$CFG_ASSIGN_RBAC" = "true" ] && ASSIGN_RBAC=1
  [ "$CFG_SKIP_RBAC" = "true" ] && SKIP_RBAC=1
  [ -z "$PACKAGE_PATH" ] && PACKAGE_PATH="$CFG_PKG"
  [ -z "$PACKAGE_URI" ] && PACKAGE_URI="$CFG_PKG_URI"
  EXTRA_TAGS_JSON="$CFG_TAGS_JSON"
fi

if [ -z "$NAME" ] || [ -z "$RESOURCE_GROUP" ]; then
  echo "Required: --name <webapp> --resource-group <rg> (or provide ./deploy.config.json)" >&2
  exit 2
fi

if [ -n "$SUBSCRIPTION_ID" ]; then
  az account set --subscription "$SUBSCRIPTION_ID"
fi
CURRENT_SUB="$(az account show --query id -o tsv | tr -d '\r')"
CURRENT_SUB_NAME="$(az account show --query name -o tsv | tr -d '\r')"
[ -z "$TARGET_SUBSCRIPTION_ID" ] && TARGET_SUBSCRIPTION_ID="$CURRENT_SUB"
[ -z "$TARGET_SUBSCRIPTION_NAME" ] && { [ "$TARGET_SUBSCRIPTION_ID" = "$CURRENT_SUB" ] && TARGET_SUBSCRIPTION_NAME="$CURRENT_SUB_NAME" || TARGET_SUBSCRIPTION_NAME="$TARGET_SUBSCRIPTION_ID"; }

resolve_id() {
  local val="$1" rtype="$2"
  if [ -z "$val" ]; then echo ""; return 0; fi
  if [[ "$val" == /subscriptions/* ]]; then echo "$val"; return 0; fi
  local found
  found="$(az resource list --name "$val" --resource-type "$rtype" --query "[?name=='$val'].id | [0]" -o tsv | tr -d '\r')"
  if [ -z "$found" ]; then
    echo "[ERROR] $rtype '$val' not found in subscription '$CURRENT_SUB'." >&2
    exit 1
  fi
  echo "$found"
}

EXISTING_PLAN_ID="$(resolve_id "$EXISTING_PLAN_ID" "Microsoft.Web/serverfarms")"
EXISTING_STORAGE_ID="$(resolve_id "$EXISTING_STORAGE_ID" "Microsoft.Storage/storageAccounts")"
EXISTING_KV_ID="$(resolve_id "$EXISTING_KV_ID" "Microsoft.KeyVault/vaults")"
EXISTING_LAW_ID="$(resolve_id "$EXISTING_LAW_ID" "Microsoft.OperationalInsights/workspaces")"

wait_active_deployments() {
  local grp="$1" pfx="$2"
  [ -z "$grp" ] && return 0
  if [ "$(az group exists -n "$grp" 2>/dev/null | tr -d '\r')" != "true" ]; then return 0; fi
  for w in $(seq 1 60); do
    local cnt
    cnt="$(az deployment group list -g "$grp" --query "length([?starts_with(name, '$pfx') && (properties.provisioningState=='Running' || properties.provisioningState=='Accepted' || properties.provisioningState=='Deleting')])" -o tsv 2>/dev/null | tr -d '\r' || echo "0")"
    [ "${cnt:-0}" = "0" ] && return 0
    [ "$w" -eq 1 ] && echo "==> Waiting for previous in-progress ARM deployment in '$grp' to settle..."
    sleep 10
  done
}

wait_active_deployments "$RESOURCE_GROUP" "armbackup-appservice-"
[ -n "$EXISTING_STORAGE_ID" ] && wait_active_deployments "$(printf '%s' "$EXISTING_STORAGE_ID" | cut -d'/' -f5)" "ab-"
[ -n "$EXISTING_KV_ID" ] && wait_active_deployments "$(printf '%s' "$EXISTING_KV_ID" | cut -d'/' -f5)" "ab-"

WEBAPP_ARM_ID="/subscriptions/$CURRENT_SUB/resourceGroups/$RESOURCE_GROUP/providers/Microsoft.Web/sites/$NAME"
RG_EXISTS="$(az group exists -n "$RESOURCE_GROUP" 2>/dev/null | tr -d '\r' || echo "false")"
EXISTING_SITE_JSON=""
if [ "$RG_EXISTS" = "true" ]; then
  EXISTING_SITE_JSON="$(az resource show --ids "$WEBAPP_ARM_ID" --api-version 2023-12-01 -o json 2>/dev/null || echo "")"
fi
if [ -n "$EXISTING_SITE_JSON" ]; then
  echo "==> Existing Web App '$NAME' detected; resuming idempotently."
  if [ -z "$EXISTING_PLAN_ID" ]; then
    EX_SITE_PLAN="$(az resource show --ids "$WEBAPP_ARM_ID" --api-version 2023-12-01 --query properties.serverFarmId -o tsv 2>/dev/null | tr -d '\r' || true)"
    if [ -n "$EX_SITE_PLAN" ] && [ "$EX_SITE_PLAN" != "None" ] && [ "$EX_SITE_PLAN" != "null" ]; then
      EXISTING_PLAN_ID="$EX_SITE_PLAN"
      echo "==> Reusing existing App Service Plan on '$NAME': $EXISTING_PLAN_ID"
    fi
  fi
  if [ -z "$VNET_SUBNET_ID" ]; then
    EX_SITE_SBN="$(az resource show --ids "$WEBAPP_ARM_ID" --api-version 2023-12-01 --query properties.virtualNetworkSubnetId -o tsv 2>/dev/null | tr -d '\r' || true)"
    if [ -n "$EX_SITE_SBN" ] && [ "$EX_SITE_SBN" != "None" ] && [ "$EX_SITE_SBN" != "null" ]; then
      VNET_SUBNET_ID="$EX_SITE_SBN"
      echo "==> Reusing existing VNet integration subnet on '$NAME': $VNET_SUBNET_ID"
    fi
  fi
fi

ENABLE_ALWAYS_ON="true"
if [ -n "$EXISTING_PLAN_ID" ]; then
  PLAN_LOC="$(az resource show --ids "$EXISTING_PLAN_ID" --api-version 2023-12-01 --query location -o tsv | tr -d '\r ' | tr '[:upper:]' '[:lower:]')"
  PLAN_TIER="$(az resource show --ids "$EXISTING_PLAN_ID" --api-version 2023-12-01 --query sku.tier -o tsv 2>/dev/null | tr -d '\r' || true)"
  if [ -z "$LOCATION" ]; then LOCATION="$PLAN_LOC"; fi
  if [ "$PLAN_TIER" = "Free" ] || [ "$PLAN_TIER" = "Shared" ]; then ENABLE_ALWAYS_ON="false"; fi
  if [ -z "$VNET_SUBNET_ID" ]; then
    PLAN_VNET_SBN="$(az rest --method get --url "https://management.azure.com${EXISTING_PLAN_ID}/virtualNetworkConnections?api-version=2023-12-01" --query "(value || @)[0].properties.vnetResourceId" -o tsv 2>/dev/null | tr -d '\r' || true)"
    if [ -n "$PLAN_VNET_SBN" ] && [ "$PLAN_VNET_SBN" != "None" ]; then
      VNET_SUBNET_ID="$PLAN_VNET_SBN"
      echo "==> Auto-detected existing VNet integration on shared App Service Plan: $VNET_SUBNET_ID"
    fi
  fi
fi

if [ -z "$LOCATION" ]; then
  LOCATION="$(az configure --list-defaults --query "[?name=='location'].value | [0]" -o tsv 2>/dev/null | tr -d '\r' || true)"
  LOCATION="${LOCATION:-koreacentral}"
fi

if [ -z "$VNET_SUBNET_ID" ] && [ -n "$PE_SUBNET_ID" ]; then
  PE_VNET_ID="${PE_SUBNET_ID%%/subnets/*}"
  if [ -n "$VNET_SUBNET_NAME" ] && [ -n "$VNET_SUBNET_PREFIX" ]; then
    PE_VNET_RG="$(printf '%s' "$PE_VNET_ID" | cut -d'/' -f5)"
    PE_VNET_NAME="$(printf '%s' "$PE_VNET_ID" | cut -d'/' -f9)"
    EX_NAMED_SBN="$(az network vnet subnet show -g "$PE_VNET_RG" --vnet-name "$PE_VNET_NAME" -n "$VNET_SUBNET_NAME" --query id -o tsv 2>/dev/null | tr -d '\r' || true)"
    if [ -n "$EX_NAMED_SBN" ]; then
      VNET_SUBNET_ID="$EX_NAMED_SBN"
    else
      echo "==> Creating VNet integration subnet '$VNET_SUBNET_NAME' ($VNET_SUBNET_PREFIX) in '$PE_VNET_NAME'..."
      VNET_SUBNET_ID="$(az network vnet subnet create -g "$PE_VNET_RG" --vnet-name "$PE_VNET_NAME" -n "$VNET_SUBNET_NAME" --address-prefixes "$VNET_SUBNET_PREFIX" --delegations "Microsoft.Web/serverFarms" --query id -o tsv | tr -d '\r')"
    fi
  else
    DEL_SUB_ID="$(az network vnet show --ids "$PE_VNET_ID" --query "subnets[?length(delegations[?serviceName=='Microsoft.Web/serverFarms']) > \`0\` && length(serviceAssociationLinks || \`[]\`) == \`0\` && !contains(name, 'logic')].id | [0]" -o tsv 2>/dev/null | tr -d '\r' || true)"
    if [ -z "$DEL_SUB_ID" ]; then
      DEL_SUB_ID="$(az network vnet show --ids "$PE_VNET_ID" --query "subnets[?length(delegations[?serviceName=='Microsoft.Web/serverFarms']) > \`0\` && !contains(name, 'logic')].id | [0]" -o tsv 2>/dev/null | tr -d '\r' || true)"
    fi
    if [ -z "$DEL_SUB_ID" ]; then
      DEL_SUB_ID="$(az network vnet show --ids "$PE_VNET_ID" --query "subnets[?length(delegations[?serviceName=='Microsoft.Web/serverFarms']) > \`0\`].id | [0]" -o tsv 2>/dev/null | tr -d '\r' || true)"
    fi
    if [ -n "$DEL_SUB_ID" ] && [ "$DEL_SUB_ID" != "None" ]; then
      VNET_SUBNET_ID="$DEL_SUB_ID"
      echo "==> Auto-detected delegated VNet integration subnet: $VNET_SUBNET_ID"
    fi
  fi
fi

if [ -n "$VNET_SUBNET_ID" ]; then
  HAS_DEL="$(az network vnet subnet show --ids "$VNET_SUBNET_ID" --query "length(delegations[?serviceName=='Microsoft.Web/serverFarms'])" -o tsv 2>/dev/null | tr -d '\r' || echo "0")"
  if [ "$HAS_DEL" = "0" ]; then
    USED_IPS="$(az network vnet subnet show --ids "$VNET_SUBNET_ID" --query "length(ipConfigurations || \`[]\`)" -o tsv 2>/dev/null | tr -d '\r' || echo "0")"
    OTHER_DEL="$(az network vnet subnet show --ids "$VNET_SUBNET_ID" --query "length(delegations || \`[]\`)" -o tsv 2>/dev/null | tr -d '\r' || echo "0")"
    if [ "${USED_IPS:-0}" != "0" ] || [ "${OTHER_DEL:-0}" != "0" ]; then
      echo "[ERROR] Subnet '$VNET_SUBNET_ID' cannot be delegated to Microsoft.Web/serverFarms because it already contains $USED_IPS IP configuration(s) or $OTHER_DEL other delegation(s). Select a dedicated /28+ subnet." >&2
      exit 1
    fi
    echo "==> Delegating empty subnet '$VNET_SUBNET_ID' to Microsoft.Web/serverFarms..."
    az network vnet subnet update --ids "$VNET_SUBNET_ID" --delegations "Microsoft.Web/serverFarms" -o none
  fi
fi

echo "==> Ensuring resource group '$RESOURCE_GROUP' in '$LOCATION'..."
if [ "$(az group exists -n "$RESOURCE_GROUP" | tr -d '\r')" != "true" ]; then
  az group create --name "$RESOURCE_GROUP" --location "$LOCATION" --tags Application=armbackup HostingPlatform=app-service -o none
fi

if [ "$USE_KV_SECRET" != "true" ]; then
  EXISTING_KV_ID=""
fi

GENERATED_PASSWORD=0
EFFECTIVE_PW_HASH=""
if [ "$AUTH_PROVIDER" = "password" ]; then
  if [ "$USE_KV_SECRET" = "true" ]; then
    if [ -z "$ADMIN_PASSWORD" ]; then
      SECRET_EXISTS=0
      if [ "$ROTATE_PASSWORD" -eq 0 ]; then
        CANDIDATE_KVS=()
        if [ -n "$EXISTING_KV_ID" ]; then
          CANDIDATE_KVS+=("$EXISTING_KV_ID")
        else
          while IFS= read -r kv_id; do
            [ -n "$kv_id" ] && CANDIDATE_KVS+=("$kv_id")
          done < <(az keyvault list -g "$RESOURCE_GROUP" --query "[].id" -o tsv 2>/dev/null | tr -d '\r' || true)
        fi
        for kv_id in "${CANDIDATE_KVS[@]}"; do
          if az rest --method get --url "https://management.azure.com${kv_id}/secrets/${NAME}-admin-password?api-version=2023-07-01" -o none >/dev/null 2>&1; then
            SECRET_EXISTS=1
            break
          fi
        done
        if [ "$SECRET_EXISTS" -eq 0 ] && [ -n "$EXISTING_SITE_JSON" ]; then
          CUR_PW_REF="$(az rest --method post --url "https://management.azure.com${WEBAPP_ARM_ID}/config/appsettings/list?api-version=2023-12-01" --query "properties.ARMBACKUP_ADMIN_PASSWORD" -o tsv 2>/dev/null | tr -d '\r' || true)"
          if [[ "$CUR_PW_REF" == *"@Microsoft.KeyVault("* ]] && [[ "$CUR_PW_REF" == *"${NAME}-admin-password"* ]]; then
            SECRET_EXISTS=1
          fi
        fi
      fi
      if [ "$SECRET_EXISTS" -eq 1 ]; then
        echo "==> Existing Key Vault secret '${NAME}-admin-password' detected; preserving current password."
      else
        if command -v openssl >/dev/null 2>&1; then
          ADMIN_PASSWORD="$(openssl rand -base64 24 | tr -dc 'A-Za-z0-9' | head -c 24)"
        else
          ADMIN_PASSWORD="$(LC_ALL=C tr -dc 'A-Za-z0-9' < /dev/urandom | head -c 24)"
        fi
        GENERATED_PASSWORD=1
        if [ "${GITHUB_ACTIONS:-}" = "true" ] && [ -n "${RUNNER_OS:-}" ]; then
          echo "::add-mask::$ADMIN_PASSWORD"
        fi
      fi
    fi
  else
    if [ -z "$ADMIN_PASSWORD" ]; then
      EFFECTIVE_PW_HASH="${ADMIN_PASSWORD_HASH:-$DEFAULT_ADMIN_PW_HASH}"
    fi
    echo "==> Sign-in configured via App Settings directly (user='$ADMIN_USERNAME', Key Vault secret disabled)."
  fi
fi

MISSING_ST_GROUPS_JSON="[]"
CREATE_KV_PE="false"
DEPLOY_WEBAPP_PE="$ENABLE_WEBAPP_PE"
PRE_EXISTING_WEBAPP_PE_ID=""
SKIP_DIAG_SETTINGS="false"
SITES_DNS_ID=""
BLOB_DNS_ID=""
VAULT_DNS_ID=""

TARGET_VNET_ID="${PE_SUBNET_ID%%/subnets/*}"
if [ -z "$TARGET_VNET_ID" ] && [ -n "$VNET_SUBNET_ID" ]; then TARGET_VNET_ID="${VNET_SUBNET_ID%%/subnets/*}"; fi
if [ -n "$TARGET_VNET_ID" ] && [ -n "$PE_SUBNET_ID" ]; then
  find_linked_zone() {
    local zname="$1"
    while IFS=$'\t' read -r zid zrg; do
      [ -z "$zid" ] && continue
      local linked
      linked="$(az network private-dns link vnet list -g "$zrg" -z "$zname" --query "length([?to_lower(virtualNetwork.id)=='${TARGET_VNET_ID,,}'])" -o tsv 2>/dev/null | tr -d '\r' || echo "0")"
      if [ "$linked" != "0" ]; then echo "$zid"; return 0; fi
    done < <(az network private-dns zone list --query "[?name=='$zname'].[id,resourceGroup]" -o tsv 2>/dev/null | tr -d '\r' || true)
    echo ""
  }
  SITES_DNS_ID="$(find_linked_zone "privatelink.azurewebsites.net")"
  BLOB_DNS_ID="$(find_linked_zone "privatelink.blob.core.windows.net")"
  VAULT_DNS_ID="$(find_linked_zone "privatelink.vaultcore.azure.net")"
fi

ALL_PES_JSON="[]"
if [ -n "$EXISTING_STORAGE_ID" ] || [ -n "$EXISTING_KV_ID" ] || [ -n "$PE_SUBNET_ID" ]; then
  ALL_PES_JSON="$(az network private-endpoint list -o json 2>/dev/null || echo "[]")"
fi

if [ -n "$EXISTING_STORAGE_ID" ]; then
  ST_PNA="$(az resource show --ids "$EXISTING_STORAGE_ID" --api-version 2025-06-01 --query properties.publicNetworkAccess -o tsv 2>/dev/null | tr -d '\r' || true)"
  if [ "$ST_PNA" != "Disabled" ]; then
    echo "[ERROR] Storage Account '$EXISTING_STORAGE_ID' has publicNetworkAccess='$ST_PNA'. Governance requires Storage Account Public Network Access to be 'Disabled' only." >&2
    exit 1
  fi
  ST_DEF="Deny"
  if [ -n "$PE_SUBNET_ID" ] && [ "$CREATE_MISSING_SHARED_PES" = "true" ] && [ -n "$PY_HELPER" ]; then
    MISSING_ST_GROUPS_JSON="$(printf '%s' "$ALL_PES_JSON" | "$PY_HELPER" -c '
import json, sys
target = sys.argv[1].lower()
pes = json.load(sys.stdin) or []
have = set()
for pe in pes:
    if pe.get("provisioningState") and pe.get("provisioningState") != "Succeeded":
        continue
    for conn in (pe.get("privateLinkServiceConnections") or []) + (pe.get("manualPrivateLinkServiceConnections") or []):
        if str(conn.get("privateLinkServiceId") or "").lower() == target:
            have.update(str(g).lower() for g in (conn.get("groupIds") or []))
print(json.dumps([g for g in ("blob",) if g not in have]))
' "$EXISTING_STORAGE_ID")"
    [ "$MISSING_ST_GROUPS_JSON" != "[]" ] && echo "==> Will create/repair missing Storage Private Endpoint: $MISSING_ST_GROUPS_JSON"
  fi
fi

if [ -n "$EXISTING_KV_ID" ] && [ -n "$PE_SUBNET_ID" ] && [ "$CREATE_MISSING_SHARED_PES" = "true" ] && [ -n "$PY_HELPER" ]; then
  KV_PNA="$(az resource show --ids "$EXISTING_KV_ID" --api-version 2023-07-01 --query properties.publicNetworkAccess -o tsv 2>/dev/null | tr -d '\r' || true)"
  if [ "$KV_PNA" = "Disabled" ]; then
    CREATE_KV_PE="$(printf '%s' "$ALL_PES_JSON" | "$PY_HELPER" -c '
import json, sys
target = sys.argv[1].lower()
pes = json.load(sys.stdin) or []
has = any(
    (not pe.get("provisioningState") or pe.get("provisioningState") == "Succeeded")
    and any(str(c.get("privateLinkServiceId") or "").lower() == target and "vault" in [str(g).lower() for g in (c.get("groupIds") or [])]
            for c in (pe.get("privateLinkServiceConnections") or []) + (pe.get("manualPrivateLinkServiceConnections") or []))
    for pe in pes
)
print("false" if has else "true")
' "$EXISTING_KV_ID")"
  fi
fi

if [ -n "$PE_SUBNET_ID" ] && [ -n "$PY_HELPER" ]; then
  eval "$(printf '%s' "$ALL_PES_JSON" | "$PY_HELPER" -c '
import json, shlex, sys
target = sys.argv[1].lower()
pes = json.load(sys.stdin) or []
found_id, found_rg, found_name = "", "", ""
for pe in pes:
    if pe.get("provisioningState") == "Succeeded":
        for c in (pe.get("privateLinkServiceConnections") or []) + (pe.get("manualPrivateLinkServiceConnections") or []):
            if str(c.get("privateLinkServiceId") or "").lower() == target and "sites" in [str(g).lower() for g in (c.get("groupIds") or [])]:
                found_id, found_rg, found_name = str(pe.get("id") or ""), str(pe.get("resourceGroup") or ""), str(pe.get("name") or "")
                break
    if found_id:
        break
print(f"PRE_EXISTING_WEBAPP_PE_ID={shlex.quote(found_id)}")
print(f"PRE_EXISTING_WEBAPP_PE_RG={shlex.quote(found_rg)}")
print(f"PRE_EXISTING_WEBAPP_PE_NAME={shlex.quote(found_name)}")
' "$WEBAPP_ARM_ID")"
  if [ -n "$PRE_EXISTING_WEBAPP_PE_ID" ]; then
    DNS_GRP_CNT="$(az network private-endpoint dns-zone-group list -g "$PRE_EXISTING_WEBAPP_PE_RG" --endpoint-name "$PRE_EXISTING_WEBAPP_PE_NAME" --query "length(@)" -o tsv 2>/dev/null | tr -d '\r' || echo "0")"
    if [ "${DNS_GRP_CNT:-0}" != "0" ] || [ -z "$SITES_DNS_ID" ]; then
      DEPLOY_WEBAPP_PE="false"
      echo "==> Existing Web App Private Endpoint '$PRE_EXISTING_WEBAPP_PE_NAME' is healthy; preserving as-is."
    fi
  fi
fi

if [ -n "$EXISTING_SITE_JSON" ] && [ -n "$EXISTING_LAW_ID" ]; then
  OTHER_DIAG="$(az rest --method get --url "https://management.azure.com${WEBAPP_ARM_ID}/providers/Microsoft.Insights/diagnosticSettings?api-version=2021-05-01-preview" --query "length((value || @)[?to_lower(properties.workspaceId)=='${EXISTING_LAW_ID,,}' && to_lower(name)!='diag-${NAME,,}'])" -o tsv 2>/dev/null | tr -d '\r' || echo "0")"
  if [ "${OTHER_DIAG:-0}" != "0" ]; then
    SKIP_DIAG_SETTINGS="true"
    echo "==> Existing diagnostic setting already streams to Log Analytics workspace; preserving without duplicate sink."
  fi
fi

if [ -z "$VNET_SUBNET_ID" ] && [ -n "$PE_SUBNET_ID" ] && { [ "${ST_PNA:-}" = "Disabled" ] || [ "${ST_DEF:-}" = "Deny" ] || [ "${KV_PNA:-}" = "Disabled" ]; }; then
  echo "[ERROR] Shared Storage or Key Vault blocks public network access, so VNet integration is required. Specify vnetIntegrationSubnetId (or vnetIntegrationSubnetName + vnetIntegrationSubnetPrefix) in deploy.config.json." >&2
  exit 1
fi

COMPILED_JSON="$HERE/azuredeploy.json"
BICEP_MAIN="$HERE/main.bicep"
if [ -n "$ROOT" ] && [ -f "$BICEP_MAIN" ]; then
  if [ ! -f "$COMPILED_JSON" ] || [ "$BICEP_MAIN" -nt "$COMPILED_JSON" ]; then
    az bicep build --file "$BICEP_MAIN" --outfile "$COMPILED_JSON" >/dev/null 2>&1 || true
  fi
fi
if [ -f "$COMPILED_JSON" ]; then
  TEMPLATE_FILE="$COMPILED_JSON"
elif [ -f "$BICEP_MAIN" ]; then
  TEMPLATE_FILE="$BICEP_MAIN"
else
  echo "[ERROR] Neither azuredeploy.json nor main.bicep found in $HERE." >&2
  exit 1
fi

RG_TAGS_JSON="$(az group show -n "$RESOURCE_GROUP" --query tags -o json 2>/dev/null || echo "{}")"
PARAM_FILE="$(mktemp)"
trap 'rm -f "$PARAM_FILE"' EXIT

ALLOWED_IPS_JSON="[]"
INBOUND_RULES_JSON="[]"
NORM_CIDRS_LIST=""
if [ -n "$ALLOWED_IP_CIDRS" ]; then
  eval "$("$PY_HELPER" - "$ALLOWED_IP_CIDRS" <<'PY'
import json, shlex, sys
raw = [x.strip() for x in sys.argv[1].split(",") if x.strip()]
norm = [x if "/" in x else f"{x}/32" for x in raw]
rules = [{"name": f"allow-client-{i+1}", "ipAddress": c, "action": "Allow", "priority": 100 + i * 10} for i, c in enumerate(norm)]
print(f"ALLOWED_IPS_JSON={shlex.quote(json.dumps(norm))}")
print(f"INBOUND_RULES_JSON={shlex.quote(json.dumps(rules))}")
print(f"NORM_CIDRS_LIST={shlex.quote(', '.join(norm))}")
PY
)"
fi

FINAL_PUBLIC_ACCESS="$WEBAPP_PUBLIC_ACCESS"
if [ "$ALLOWED_IPS_JSON" != "[]" ]; then
  FINAL_PUBLIC_ACCESS="Enabled"
fi

# Stage 1: App Service MUST be created with Public Network Access = Disabled on initial PUT.
ARM_PUBLIC_ACCESS="Disabled"
ARM_ALLOWED_IPS_JSON="[]"
if [ -n "$EXISTING_SITE_JSON" ] && [ "$ALLOWED_IPS_JSON" != "[]" ]; then
  EX_SITE_PNA="$(az resource show --ids "$WEBAPP_ARM_ID" --api-version 2023-12-01 --query properties.publicNetworkAccess -o tsv 2>/dev/null | tr -d '\r' || true)"
  if [ "$EX_SITE_PNA" = "Enabled" ]; then
    ARM_PUBLIC_ACCESS="Enabled"
    ARM_ALLOWED_IPS_JSON="$ALLOWED_IPS_JSON"
  fi
fi

DO_RBAC="false"
if [ "$ASSIGN_RBAC" -eq 1 ] && [ "$SKIP_RBAC" -eq 0 ]; then
  DO_RBAC="true"
fi

"$PY_HELPER" - "$PARAM_FILE" "$RG_TAGS_JSON" "$EXTRA_TAGS_JSON" "$MISSING_ST_GROUPS_JSON" "$ARM_ALLOWED_IPS_JSON" \
  "$LOCATION" "$NAME" "$PYTHON_VERSION" "$PLAN_SKU" "$ENABLE_ALWAYS_ON" \
  "$EXISTING_PLAN_ID" "$EXISTING_STORAGE_ID" "$EXISTING_KV_ID" "$EXISTING_LAW_ID" \
  "$STORAGE_NAMESPACE" "$STORAGE_CONTAINER_NAME" "$STORAGE_BLOB_PREFIX" \
  "$WORKSPACE_DISPLAY_NAME" "$TARGET_SUBSCRIPTION_ID" "$TARGET_SUBSCRIPTION_NAME" "$RESTORE_ENABLED" "$ACTIVITY_DAYS" \
  "$ARM_PUBLIC_ACCESS" "$([ "$ORYX_BUILD" -eq 1 ] && echo true || echo false)" \
  "true" "$AUTH_PROVIDER" "$ADMIN_USERNAME" "$ADMIN_PASSWORD" \
  "$LOG_WORKSPACE_GUID" "$LOG_DCR_ID" "$LOG_RULE_ID" "$LOG_ENDPOINT" "$LOG_STREAM" \
  "$VNET_SUBNET_ID" "$VNET_ROUTE_ALL" "$PE_SUBNET_ID" "$PE_RESOURCE_GROUP" "$DEPLOY_WEBAPP_PE" "$CREATE_KV_PE" \
  "$SITES_DNS_ID" "$BLOB_DNS_ID" "$VAULT_DNS_ID" \
  "$DO_RBAC" "$RESOURCE_SCOPED_RBAC" "$SKIP_DIAG_SETTINGS" "$USE_KV_SECRET" "$EFFECTIVE_PW_HASH" <<'PY'
import json, sys
a = sys.argv[1:]
out_path = a[0]
rg_tags = json.loads(a[1] or "{}") or {}
extra_tags = json.loads(a[2] or "{}") or {}
missing_groups = json.loads(a[3] or "[]")
allowed_ips = json.loads(a[4] or "[]")
tags = {"Application": "armbackup", "HostingPlatform": "app-service"}
for k, v in rg_tags.items():
    if not str(k).startswith("hidden-"):
        tags[str(k)] = str(v)
for k, v in extra_tags.items():
    tags[str(k)] = str(v)
if ("Service" in tags or "ServiceGrade" in tags or "Name" in tags) and "Name" not in extra_tags:
    tags["Name"] = a[6]
b = lambda s: str(s).lower() == "true"
params = {
    "$schema": "https://schema.management.azure.com/schemas/2019-04-01/deploymentParameters.json#",
    "contentVersion": "1.0.0.0",
    "parameters": {
        "location": {"value": a[5]},
        "webAppName": {"value": a[6]},
        "pythonVersion": {"value": a[7]},
        "appServicePlanSku": {"value": a[8]},
        "enableAlwaysOn": {"value": b(a[9])},
        "existingAppServicePlanId": {"value": a[10]},
        "existingStorageAccountId": {"value": a[11]},
        "existingKeyVaultId": {"value": a[12]},
        "existingLogAnalyticsWorkspaceId": {"value": a[13]},
        "skipDiagnosticSettings": {"value": b(a[44])},
        "storageNamespaceOverride": {"value": a[14]},
        "storageContainerOverride": {"value": a[15]},
        "storageBlobPrefix": {"value": a[16]},
        "workspaceDisplayName": {"value": a[17]},
        "targetSubscriptionId": {"value": a[18]},
        "targetSubscriptionName": {"value": a[19]},
        "restoreEnabled": {"value": b(a[20])},
        "activityDays": {"value": int(a[21] or "2")},
        "webAppPublicNetworkAccess": {"value": a[22]},
        "allowedIpCidrs": {"value": allowed_ips},
        "useOryxBuild": {"value": b(a[23])},
        "enablePrivateNetworking": {"value": b(a[24])},
        "authProvider": {"value": a[25]},
        "useKeyVaultSecret": {"value": b(a[45])},
        "adminUsername": {"value": a[26]},
        "adminPasswordHash": {"value": a[46]},
        "adminPassword": {"value": a[27]},
        "logWorkspaceGuid": {"value": a[28]},
        "logDcrId": {"value": a[29]},
        "logRuleId": {"value": a[30]},
        "logEndpoint": {"value": a[31]},
        "logStream": {"value": a[32]},
        "vnetIntegrationSubnetId": {"value": a[33]},
        "vnetRouteAllEnabled": {"value": b(a[34])},
        "privateEndpointSubnetId": {"value": a[35]},
        "privateEndpointResourceGroup": {"value": a[36]},
        "enableWebAppPrivateEndpoint": {"value": b(a[37])},
        "storagePrivateEndpointGroups": {"value": missing_groups},
        "createKeyVaultPrivateEndpoint": {"value": b(a[38])},
        "sitesPrivateDnsZoneId": {"value": a[39]},
        "blobPrivateDnsZoneId": {"value": a[40]},
        "vaultPrivateDnsZoneId": {"value": a[41]},
        "assignDataPlaneRbac": {"value": b(a[42])},
        "resourceScopedDataPlaneRbac": {"value": b(a[43])},
        "tags": {"value": tags},
    },
}
open(out_path, "w", encoding="utf-8").write(json.dumps(params, indent=2))
PY

echo "==> Validating ARM deployment with what-if ($(basename "$TEMPLATE_FILE"))..."
az deployment group what-if \
  --resource-group "$RESOURCE_GROUP" \
  --name "armbackup-appservice-preview" \
  --template-file "$TEMPLATE_FILE" \
  --parameters "@$PARAM_FILE"

if [ "$WHAT_IF_ONLY" -eq 1 ]; then
  if [ "$ALLOWED_IPS_JSON" != "[]" ] && [ "$ARM_PUBLIC_ACCESS" = "Disabled" ]; then
    echo "    [Post-Creation Plan] After creating '$NAME' with Public Network Access = Disabled, the script will switch to 'Enabled from select virtual networks and IP addresses' (Unmatched=Deny) with allowed IPs ($NORM_CIDRS_LIST) and verify before starting ZIP deployment."
  fi
  echo "What-if preview completed (--what-if). No changes deployed."
  exit 0
fi

DEPLOY_NAME="armbackup-appservice-$(date -u +%Y%m%d%H%M%S)"
echo "==> Provisioning App Service infrastructure ($DEPLOY_NAME, initial PublicNetworkAccess=$ARM_PUBLIC_ACCESS)..."
az deployment group create \
  --resource-group "$RESOURCE_GROUP" \
  --name "$DEPLOY_NAME" \
  --template-file "$TEMPLATE_FILE" \
  --parameters "@$PARAM_FILE" \
  -o none

PRINCIPAL_ID="$(az deployment group show -g "$RESOURCE_GROUP" -n "$DEPLOY_NAME" --query properties.outputs.principalId.value -o tsv | tr -d '\r')"
WEBAPP_HOST="$(az deployment group show -g "$RESOURCE_GROUP" -n "$DEPLOY_NAME" --query properties.outputs.webAppHostName.value -o tsv | tr -d '\r')"
WEBAPP_URL="$(az deployment group show -g "$RESOURCE_GROUP" -n "$DEPLOY_NAME" --query properties.outputs.webAppUrl.value -o tsv | tr -d '\r')"
STORAGE_NAME="$(az deployment group show -g "$RESOURCE_GROUP" -n "$DEPLOY_NAME" --query properties.outputs.storageAccountName.value -o tsv | tr -d '\r')"
STORAGE_CONTAINER="$(az deployment group show -g "$RESOURCE_GROUP" -n "$DEPLOY_NAME" --query properties.outputs.storageContainerName.value -o tsv | tr -d '\r')"
KV_NAME="$(az deployment group show -g "$RESOURCE_GROUP" -n "$DEPLOY_NAME" --query properties.outputs.keyVaultName.value -o tsv | tr -d '\r')"
KV_SECRET="$(az deployment group show -g "$RESOURCE_GROUP" -n "$DEPLOY_NAME" --query properties.outputs.keyVaultEntryName.value -o tsv | tr -d '\r')"
WEBAPP_PE_ID="$(az deployment group show -g "$RESOURCE_GROUP" -n "$DEPLOY_NAME" --query properties.outputs.webAppPrivateEndpointId.value -o tsv 2>/dev/null | tr -d '\r' || true)"
[ -z "$WEBAPP_PE_ID" ] && WEBAPP_PE_ID="$PRE_EXISTING_WEBAPP_PE_ID"

# Stage 2: Switch App Service Public Network Access to 'Enabled from select virtual networks and IP addresses'
# with allowed IPs (e.g. 211.47.20.25/32, 211.47.20.26/32) and Unmatched=Deny, then verify BEFORE starting ZIP deployment.
if [ "$ALLOWED_IPS_JSON" != "[]" ]; then
  echo "==> Configuring App Service Public Network Access -> 'Enabled from select virtual networks and IP addresses' (Allowed: $NORM_CIDRS_LIST | Unmatched=Deny)..."
  SEL_SITE_JSON="$(mktemp)"
  SEL_CFG_JSON="$(mktemp)"
  cat > "$SEL_SITE_JSON" <<JSON
{"location":"$LOCATION","properties":{"publicNetworkAccess":"Enabled","siteConfig":{"publicNetworkAccess":"Enabled","ipSecurityRestrictions":$INBOUND_RULES_JSON,"ipSecurityRestrictionsDefaultAction":"Deny","scmIpSecurityRestrictions":$INBOUND_RULES_JSON,"scmIpSecurityRestrictionsDefaultAction":"Deny","scmIpSecurityRestrictionsUseMain":false}}}
JSON
  cat > "$SEL_CFG_JSON" <<JSON
{"properties":{"ipSecurityRestrictions":$INBOUND_RULES_JSON,"ipSecurityRestrictionsDefaultAction":"Deny","scmIpSecurityRestrictions":$INBOUND_RULES_JSON,"scmIpSecurityRestrictionsDefaultAction":"Deny","scmIpSecurityRestrictionsUseMain":false}}
JSON
  az rest --method patch --url "https://management.azure.com${WEBAPP_ARM_ID}?api-version=2023-12-01" --body "@$SEL_SITE_JSON" -o none
  az rest --method patch --url "https://management.azure.com${WEBAPP_ARM_ID}/config/web?api-version=2023-12-01" --body "@$SEL_CFG_JSON" -o none
  rm -f "$SEL_SITE_JSON" "$SEL_CFG_JSON"

  IP_VERIFIED=0
  for _ in $(seq 1 12); do
    SITE_CHK="$(az rest --method get --url "https://management.azure.com${WEBAPP_ARM_ID}?api-version=2023-12-01" -o json 2>/dev/null || echo "{}")"
    WEB_CHK="$(az rest --method get --url "https://management.azure.com${WEBAPP_ARM_ID}/config/web?api-version=2023-12-01" -o json 2>/dev/null || echo "{}")"
    OK_RULES="$("$PY_HELPER" - "$ALLOWED_IPS_JSON" "$SITE_CHK" "$WEB_CHK" <<'PY'
import json, sys
expected = set(json.loads(sys.argv[1]))
site = json.loads(sys.argv[2] or "{}").get("properties") or {}
web = json.loads(sys.argv[3] or "{}").get("properties") or {}
main_ips = {r.get("ipAddress") for r in (web.get("ipSecurityRestrictions") or []) if r.get("action") == "Allow"}
scm_ips = {r.get("ipAddress") for r in (web.get("scmIpSecurityRestrictions") or []) if r.get("action") == "Allow"}
ok = (
    site.get("publicNetworkAccess") == "Enabled"
    and web.get("ipSecurityRestrictionsDefaultAction") == "Deny"
    and web.get("scmIpSecurityRestrictionsDefaultAction") == "Deny"
    and expected.issubset(main_ips)
    and expected.issubset(scm_ips)
)
print("yes" if ok else "no")
PY
)"
    if [ "$OK_RULES" = "yes" ]; then
      IP_VERIFIED=1
      break
    fi
    sleep 5
  done
  if [ "$IP_VERIFIED" -ne 1 ]; then
    echo "[ERROR] App Service '$NAME' did not confirm Allowed IPs ($NORM_CIDRS_LIST) with Unmatched=Deny within 60s; aborting before code deployment." >&2
    exit 1
  fi
  echo "    Verified App Service network rules: PublicNetworkAccess=Enabled (select networks & IPs), Allowed=$NORM_CIDRS_LIST, Unmatched=Deny. Proceeding to deployment."
fi

SCM_HOST="${WEBAPP_HOST%%.*}.scm.${WEBAPP_HOST#*.}"
if [ "$GENERATED_PASSWORD" -eq 1 ]; then
  if [ "${GITHUB_ACTIONS:-}" = "true" ]; then
    echo "==> Generated admin password stored in Key Vault '$KV_NAME' secret '$KV_SECRET'."
  else
    echo "==> Generated admin password (stored in Key Vault '$KV_NAME', shown once): $ADMIN_PASSWORD"
  fi
fi

if [ "$DO_RBAC" = "true" ]; then
  echo "==> Granting Subscription Reader (+ optional Contributor) RBAC..."
  az role assignment create \
    --assignee-object-id "$PRINCIPAL_ID" \
    --assignee-principal-type ServicePrincipal \
    --role "acdd72a7-3385-48ef-bd42-f606fba81ae7" \
    --scope "/subscriptions/$TARGET_SUBSCRIPTION_ID" -o none 2>/dev/null || true
  if [ "$RESTORE_ENABLED" = "true" ]; then
    az role assignment create \
      --assignee-object-id "$PRINCIPAL_ID" \
      --assignee-principal-type ServicePrincipal \
      --role "b24988ac-6180-42a0-ab88-20f7382dd24c" \
      --scope "/subscriptions/$TARGET_SUBSCRIPTION_ID" -o none 2>/dev/null || true
  fi
fi

if [ -z "$PACKAGE_URI" ]; then
  if [ -z "$PACKAGE_PATH" ]; then
    if [ -f "$HERE/armbackup.zip" ]; then
      PACKAGE_PATH="$HERE/armbackup.zip"
    elif [ -n "$ROOT" ]; then
      PACKAGE_PATH="$ROOT/artifacts/appservice/armbackup.zip"
      if [ "$SKIP_BUILD" -eq 0 ] || [ ! -f "$PACKAGE_PATH" ]; then
        echo "==> Building App Service ZIP package..."
        BUILD_FLAGS=(--output "$PACKAGE_PATH" --python-version "$PYTHON_VERSION")
        if [ "$ORYX_BUILD" -eq 1 ]; then BUILD_FLAGS+=(--oryx-build); fi
        bash "$HERE/build-package.sh" "${BUILD_FLAGS[@]}"
      fi
    else
      echo "[ERROR] No armbackup.zip found next to deploy-appservice.sh. Pass --package <path.zip>." >&2
      exit 1
    fi
  fi

  if [ ! -f "$PACKAGE_PATH" ]; then
    echo "[ERROR] Package not found: $PACKAGE_PATH" >&2
    exit 1
  fi
  if [ -f "${PACKAGE_PATH}.sha256" ] && command -v sha256sum >/dev/null 2>&1; then
    EXPECTED_SHA="$(awk '{print tolower($1)}' "${PACKAGE_PATH}.sha256")"
    ACTUAL_SHA="$(sha256sum "$PACKAGE_PATH" | awk '{print tolower($1)}')"
    if [ -n "$EXPECTED_SHA" ] && [ "$EXPECTED_SHA" != "$ACTUAL_SHA" ]; then
      echo "[ERROR] SHA-256 mismatch for $PACKAGE_PATH (expected $EXPECTED_SHA, got $ACTUAL_SHA)." >&2
      exit 1
    fi
  fi
fi

WEBAPP_PE_IP=""
if [ -n "$WEBAPP_PE_ID" ]; then
  WEBAPP_PE_IP="$(az resource show --ids "$WEBAPP_PE_ID" --api-version 2024-05-01 --query "properties.customDnsConfigs[0].ipAddresses[0]" -o tsv 2>/dev/null | tr -d '\r' || true)"
  if [ -z "$WEBAPP_PE_IP" ] || [ "$WEBAPP_PE_IP" = "None" ]; then
    NIC_ID="$(az resource show --ids "$WEBAPP_PE_ID" --api-version 2024-05-01 --query "properties.networkInterfaces[0].id" -o tsv 2>/dev/null | tr -d '\r' || true)"
    if [ -n "$NIC_ID" ] && [ "$NIC_ID" != "None" ]; then
      WEBAPP_PE_IP="$(az network nic show --ids "$NIC_ID" --query "ipConfigurations[0].privateIPAddress" -o tsv 2>/dev/null | tr -d '\r' || true)"
    fi
  fi
fi

PRE_STATE="$(az webapp show -g "$RESOURCE_GROUP" -n "$NAME" --query state -o tsv 2>/dev/null | tr -d '\r' || true)"
if [ "$PRE_STATE" = "Stopped" ]; then
  echo "==> Starting stopped Web App '$NAME' before deployment..."
  az webapp start -g "$RESOURCE_GROUP" -n "$NAME" -o none
  sleep 5
fi

DEPLOY_MODE="arm_onedeploy"
USE_RESOLVE=0
if [ -z "$PACKAGE_URI" ]; then
  MAX_PROBES=4
  [ "$FINAL_PUBLIC_ACCESS" = "Enabled" ] && MAX_PROBES=12
  CONSEC_OK=0
  for P_IDX in $(seq 1 "$MAX_PROBES"); do
    PROBE_TOKEN="$(az account get-access-token --resource https://management.azure.com --query accessToken -o tsv | tr -d '\r')"
    CODE="$(curl -sS -o /dev/null -w '%{http_code}' --connect-timeout 5 --max-time 15 -H "Authorization: Bearer $PROBE_TOKEN" "https://$SCM_HOST/api/deployments" || echo "000")"
    if [ "$CODE" = "200" ]; then
      CONSEC_OK=$((CONSEC_OK + 1))
      if [ "$CONSEC_OK" -ge 2 ] || [ "$FINAL_PUBLIC_ACCESS" = "Disabled" ]; then
        DEPLOY_MODE="kudu_direct"
        break
      fi
      sleep 3
      continue
    fi
    CONSEC_OK=0
    if [ -n "$WEBAPP_PE_IP" ] && [ "$WEBAPP_PE_IP" != "None" ]; then
      RCODE="$(curl -sS -o /dev/null -w '%{http_code}' --connect-timeout 4 --max-time 15 --resolve "${SCM_HOST}:443:${WEBAPP_PE_IP}" -H "Authorization: Bearer $PROBE_TOKEN" "https://$SCM_HOST/api/deployments" || echo "000")"
      if [ "$RCODE" = "200" ]; then
        DEPLOY_MODE="kudu_resolve"
        USE_RESOLVE=1
        break
      fi
    fi
    if [ "$FINAL_PUBLIC_ACCESS" = "Disabled" ] && [ "$CODE" = "403" ]; then
      break
    fi
    if [ "$FINAL_PUBLIC_ACCESS" = "Enabled" ] && [ "$CODE" = "403" ] && [ "$P_IDX" -ge 2 ]; then
      SEEN_IP="$(curl -sI --connect-timeout 5 --max-time 10 "https://$SCM_HOST/api/deployments" 2>/dev/null | awk -F': ' 'tolower($1)=="x-ms-forbidden-ip"{gsub(/\r/,"",$2); print $2; exit}')"
      if [ -n "$SEEN_IP" ] && [[ "$ALLOWED_IPS_JSON" != *"\"${SEEN_IP}/32\""* ]]; then
        break
      fi
    fi
    sleep 6
  done
fi

TEMP_SCM_OPENED=0
restore_scm_lockdown() {
  rm -f "$PARAM_FILE"
  if [ "$TEMP_SCM_OPENED" -eq 1 ]; then
    echo "==> Restoring Web App & SCM network lockdown (publicNetworkAccess=$FINAL_PUBLIC_ACCESS, Unmatched=Deny)..."
    CLOSE_JSON="$(mktemp)"
    DEF_ACT="Deny"
    if [ "$FINAL_PUBLIC_ACCESS" = "Enabled" ] && [ "$INBOUND_RULES_JSON" = "[]" ]; then DEF_ACT="Allow"; fi
    cat > "$CLOSE_JSON" <<JSON
{"location":"$LOCATION","properties":{"publicNetworkAccess":"$FINAL_PUBLIC_ACCESS","siteConfig":{"publicNetworkAccess":"$FINAL_PUBLIC_ACCESS","ipSecurityRestrictions":$INBOUND_RULES_JSON,"ipSecurityRestrictionsDefaultAction":"$DEF_ACT","scmIpSecurityRestrictions":$INBOUND_RULES_JSON,"scmIpSecurityRestrictionsDefaultAction":"$DEF_ACT","scmIpSecurityRestrictionsUseMain":false}}}
JSON
    az rest --method patch --url "https://management.azure.com${WEBAPP_ARM_ID}?api-version=2023-12-01" --body "@$CLOSE_JSON" -o none 2>/dev/null || true
    rm -f "$CLOSE_JSON"
  fi
}
trap restore_scm_lockdown EXIT

if [ -z "$PACKAGE_URI" ] && [ "$DEPLOY_MODE" != "kudu_direct" ] && [ "$DEPLOY_MODE" != "kudu_resolve" ]; then
  CALLER_IP="$(curl -fsS --connect-timeout 4 --max-time 8 https://api.ipify.org 2>/dev/null | tr -d ' \r\n' || curl -fsS --connect-timeout 4 --max-time 8 https://ifconfig.me/ip 2>/dev/null | tr -d ' \r\n' || true)"
  if [ -z "$CALLER_IP" ]; then
    echo "[ERROR] Cannot reach Kudu SCM for '$NAME' from this network and could not detect caller public IPv4. Run from an allowed IP ($NORM_CIDRS_LIST) or VNet jumpbox." >&2
    exit 1
  fi
  echo "==> Temporarily allowing deployer IP ($CALLER_IP/32) on Kudu SCM only (DefaultAction=Deny)..."
  SCM_TEMP_RULES_JSON="$("$PY_HELPER" - "$INBOUND_RULES_JSON" "$CALLER_IP" <<'PY'
import json, sys
base = json.loads(sys.argv[1] or "[]")
ip = sys.argv[2]
print(json.dumps([{"name": "temp-deployer-scm", "ipAddress": f"{ip}/32", "action": "Allow", "priority": 90}] + base))
PY
)"
  OPEN_JSON="$(mktemp)"
  cat > "$OPEN_JSON" <<JSON
{"location":"$LOCATION","properties":{"publicNetworkAccess":"Enabled","siteConfig":{"publicNetworkAccess":"Enabled","ipSecurityRestrictions":$INBOUND_RULES_JSON,"ipSecurityRestrictionsDefaultAction":"Deny","scmIpSecurityRestrictions":$SCM_TEMP_RULES_JSON,"scmIpSecurityRestrictionsDefaultAction":"Deny","scmIpSecurityRestrictionsUseMain":false}}}
JSON
  az rest --method patch --url "https://management.azure.com${WEBAPP_ARM_ID}?api-version=2023-12-01" --body "@$OPEN_JSON" -o none
  rm -f "$OPEN_JSON"
  TEMP_SCM_OPENED=1
  for _ in $(seq 1 15); do
    PROBE_TOKEN="$(az account get-access-token --resource https://management.azure.com --query accessToken -o tsv | tr -d '\r')"
    CODE="$(curl -sS -o /dev/null -w '%{http_code}' --connect-timeout 5 --max-time 15 -H "Authorization: Bearer $PROBE_TOKEN" "https://$SCM_HOST/api/deployments" || echo "000")"
    [ "$CODE" = "200" ] && break
    sleep 6
  done
  DEPLOY_MODE="kudu_temp_scm_ip"
fi

if [ "$DEPLOY_MODE" = "kudu_direct" ] || [ "$DEPLOY_MODE" = "kudu_resolve" ] || [ "$DEPLOY_MODE" = "kudu_temp_scm_ip" ]; then
  echo "==> Deploying ZIP directly to App Service Kudu ($DEPLOY_MODE)..."
  RESOLVE_ARGS=()
  if [ "$USE_RESOLVE" -eq 1 ]; then RESOLVE_ARGS=(--resolve "${SCM_HOST}:443:${WEBAPP_PE_IP}"); fi
  DEPLOY_TOKEN="$(az account get-access-token --resource https://management.azure.com --query accessToken -o tsv | tr -d '\r')"
  HTTP_CODE="$(curl -sS -o /dev/null -w '%{http_code}' --connect-timeout 15 --max-time 900 "${RESOLVE_ARGS[@]}" \
    -X POST -H "Authorization: Bearer $DEPLOY_TOKEN" -H "Content-Type: application/octet-stream" \
    --data-binary "@$PACKAGE_PATH" "https://$SCM_HOST/api/publish?type=zip&clean=true&restart=true&async=true")"
  if [[ ! "$HTTP_CODE" =~ ^20[0-9]$ ]]; then
    echo "[ERROR] Kudu ZIP upload failed (HTTP $HTTP_CODE)." >&2
    exit 1
  fi
  echo "==> Waiting for Kudu extraction to complete..."
  for _ in $(seq 1 60); do
    sleep 8
    DEPLOY_TOKEN="$(az account get-access-token --resource https://management.azure.com --query accessToken -o tsv | tr -d '\r')"
    DEP_JSON="$(curl -fsS --connect-timeout 8 --max-time 25 "${RESOLVE_ARGS[@]}" -H "Authorization: Bearer $DEPLOY_TOKEN" "https://$SCM_HOST/api/deployments" 2>/dev/null || echo "[]")"
    STATUS="$(printf '%s' "$DEP_JSON" | "$PY_HELPER" -c 'import json,sys; d=json.load(sys.stdin) or []; print(f"{d[0].get(\"complete\")}:{d[0].get(\"status\")}" if d else "")')"
    if [ "$STATUS" = "True:4" ]; then break; fi
    if [[ "$STATUS" == True:* ]]; then
      echo "[ERROR] Kudu deployment failed ($STATUS)." >&2
      exit 1
    fi
  done
else
  echo "==> Deploying PackageUri via ARM Control-Plane OneDeploy..."
  ONEDEPLOY_JSON="$(mktemp)"
  printf '{"properties":{"packageUri":"%s","type":"zip","clean":true}}' "$PACKAGE_URI" > "$ONEDEPLOY_JSON"
  az rest --method put --url "https://management.azure.com${WEBAPP_ARM_ID}/extensions/onedeploy?api-version=2023-12-01" --body "@$ONEDEPLOY_JSON" -o none
  rm -f "$ONEDEPLOY_JSON"
fi

restore_scm_lockdown
TEMP_SCM_OPENED=0

echo "==> Restarting Web App '$NAME'..."
az webapp restart -g "$RESOURCE_GROUP" -n "$NAME" -o none
if [ "$USE_KV_SECRET" = "true" ]; then
  az rest --method post --url "https://management.azure.com${WEBAPP_ARM_ID}/config/configreferences/appsettings/refresh?api-version=2023-12-01" -o none 2>/dev/null || true
fi
sleep 10

if [ "$NO_WAIT_HEALTH" -eq 0 ]; then
  if [ "$DEPLOY_MODE" = "kudu_direct" ] || [ "$DEPLOY_MODE" = "kudu_resolve" ]; then
    echo "==> Waiting for $WEBAPP_URL/health..."
    RESOLVE_WEB=()
    if [ "$USE_RESOLVE" -eq 1 ]; then RESOLVE_WEB=(--resolve "${WEBAPP_HOST}:443:${WEBAPP_PE_IP}"); fi
    HEALTHY=0
    for _ in $(seq 1 40); do
      HC="$(curl -sS -o /dev/null -w '%{http_code}' --connect-timeout 8 --max-time 15 "${RESOLVE_WEB[@]}" "$WEBAPP_URL/health" || echo "000")"
      if [ "$HC" = "200" ]; then HEALTHY=1; break; fi
      sleep 8
    done
    if [ "$HEALTHY" -ne 1 ]; then
      echo "[ERROR] App did not become healthy on $WEBAPP_URL/health." >&2
      exit 1
    fi
  else
    SITE_STATE="$(az webapp show -g "$RESOURCE_GROUP" -n "$NAME" --query state -o tsv | tr -d '\r')"
    echo "==> Web App state: $SITE_STATE (inbound publicNetworkAccess=$FINAL_PUBLIC_ACCESS)"
  fi
fi

PUBLIC_SUMMARY="$FINAL_PUBLIC_ACCESS"
if [ "$ALLOWED_IPS_JSON" != "[]" ]; then
  PUBLIC_SUMMARY="Enabled from select virtual networks and IP addresses (Allowed: $NORM_CIDRS_LIST | Unmatched: Deny)"
fi

echo ""
echo "Deployment succeeded."
echo "  URL:             $WEBAPP_URL"
[ -n "$WEBAPP_PE_IP" ] && [ "$WEBAPP_PE_IP" != "None" ] && echo "  Private IP:      $WEBAPP_PE_IP (groupIds: sites)"
echo "  Public Access:   $PUBLIC_SUMMARY"
echo "  Managed ID:      $PRINCIPAL_ID"
echo "  Storage:         $STORAGE_NAME (PublicNetworkAccess=Disabled; container='$STORAGE_CONTAINER' initialized by App Service Startup code)"
if [ "$USE_KV_SECRET" = "true" ]; then
  echo "  Sign-in:         $ADMIN_USERNAME / Key Vault secret '$KV_SECRET' in '$KV_NAME'"
else
  echo "  Sign-in:         $ADMIN_USERNAME (App Settings scrypt hash configured directly — no Key Vault secret used)"
fi
if [ "$DO_RBAC" != "true" ]; then
  echo ""
  echo "[Next Step for RBAC Administrator] Grant roles to Managed Identity '$PRINCIPAL_ID' then restart '$NAME':"
  echo "  1. Storage '$STORAGE_NAME': Storage Blob Data Contributor (App Service Startup code auto-creates isolated container '$STORAGE_CONTAINER' & seeds state via VNet Integration -> Blob PE)"
  if [ "$USE_KV_SECRET" = "true" ]; then
    echo "  2. Key Vault '$KV_NAME': Key Vault Secrets User (scoped to secret '$KV_SECRET')"
    echo "  3. Target Subscription '$TARGET_SUBSCRIPTION_ID': Reader (add Contributor if restoreEnabled=true)"
    echo "  4. Restart after RBAC propagation: az webapp restart -g $RESOURCE_GROUP -n $NAME"
  else
    echo "  2. Target Subscription '$TARGET_SUBSCRIPTION_ID': Reader (add Contributor if restoreEnabled=true)"
    echo "  3. Restart after RBAC propagation: az webapp restart -g $RESOURCE_GROUP -n $NAME"
  fi
fi
