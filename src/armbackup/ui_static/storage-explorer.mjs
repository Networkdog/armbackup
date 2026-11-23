import { createPaneState } from "./tree-pane.mjs";

export const STORAGE_LAYOUT_KEY = "armbackup.storage-layout";
export const STORAGE_WIDTH_KEY = "armbackup.storage-tree-width";

export function createStorageState(storage = globalThis.localStorage) {
  return {
    data: null,
    index: null,
    loading: false,
    error: "",
    loadedAt: 0,
    requestPrefix: "",
    query: "",
    mode: "current",
    sort: "size-desc",
    focusId: "",
    expandedDirs: new Set(),
    initialized: false,
    pane: createPaneState(storage, {
      layoutKey: STORAGE_LAYOUT_KEY,
      widthKey: STORAGE_WIDTH_KEY,
      defaultWidth: 264,
    }),
  };
}

export function formatBytes(bytes) {
  const value = Math.max(0, Number(bytes) || 0);
  if (value < 1024) return `${Math.round(value).toLocaleString("en-US")} B`;
  const kib = value / 1024;
  if (kib < 1024) return `${kib.toFixed(kib < 10 ? 2 : 1)} KiB`;
  const mib = kib / 1024;
  if (mib < 1024) return `${mib.toFixed(2)} MiB`;
  const gib = mib / 1024;
  return `${gib.toFixed(2)} GiB`;
}

export function exactBytes(bytes) {
  return `${Math.max(0, Math.round(Number(bytes) || 0)).toLocaleString("en-US")} B`;
}

export function formatShare(bytes, totalBytes) {
  const part = Math.max(0, Number(bytes) || 0);
  const whole = Math.max(0, Number(totalBytes) || 0);
  if (whole <= 0 || part <= 0) return { pct: 0, text: "0.0%" };
  const raw = (part / whole) * 100;
  if (raw < 0.1) return { pct: 1, text: "<0.1%" };
  const clamped = Math.min(100, raw);
  return { pct: Number(clamped.toFixed(1)), text: `${clamped.toFixed(1)}%` };
}

function stripConfiguredPrefix(path, configuredPrefix) {
  if (!configuredPrefix) return path;
  if (path === configuredPrefix) return "";
  if (path.startsWith(`${configuredPrefix}/`)) return path.slice(configuredPrefix.length + 1);
  return path;
}

export function classifyDirectory(path, configuredPrefix = "") {
  if (!path) return "컨테이너 루트";
  if (configuredPrefix && path === configuredPrefix) return "기본 백업 경로";
  const rel = stripConfiguredPrefix(path, configuredPrefix);
  if (rel === "runs") return "백업 실행 보관소";
  if (/^runs\/[^/]+$/.test(rel)) return "백업 실행";
  if (/^runs\/[^/]+\/resources$/.test(rel)) return "리소스 원본 스냅샷";
  if (rel === "console") return "콘솔 운영 데이터";
  if (rel === "console/views" || rel.startsWith("console/views/")) return "화면 상태 캐시";
  if (rel === "console/jobs" || rel.startsWith("console/jobs/")) return "작업 실행 기록";
  if (rel === "console/policies") return "백업 대상 정책";
  if (rel === "console/labels") return "백업 설명 라벨";
  if (rel === "console/plans" || rel === "console/bundle-plans") return "복원·복제 검토 계획";
  if (rel === "console/claims" || rel === "console/bundle-claims") return "복원 일회 승인 기록";
  if (rel.startsWith("console/schedule-")) return "일일 백업 예약";
  if (rel === "locks") return "동시 실행 잠금";
  return "디렉터리";
}

export function classifyBlob(name, configuredPrefix = "") {
  const rel = stripConfiguredPrefix(name, configuredPrefix);
  if (/^runs\/[^/]+\/manifest\.json$/.test(rel)) return { label: "실행 매니페스트", icon: "logs" };
  if (/^runs\/[^/]+\/COMPLETE\.json$/.test(rel)) return { label: "완료·무결성 표식", icon: "check" };
  if (/^runs\/[^/]+\/discovery\.json$/.test(rel)) return { label: "ARG 발견 목록", icon: "search" };
  if (/^runs\/[^/]+\/resources\/[^/]+\.json$/.test(rel)) return { label: "리소스 형상 원본", icon: "box" };
  if (/^console\/views\/objects\/[^/]+\.json$/.test(rel)) return { label: "화면 캐시 스냅샷", icon: "grid" };
  if (/^console\/views\/(?:heads|status|complete)\/[^/]+\.json$/.test(rel)) return { label: "화면 캐시 포인터", icon: "clock" };
  if (/^console\/policies\/[^/]+\.json$/.test(rel)) return { label: "백업 대상 정책", icon: "sliders" };
  if (/^console\/labels\/[^/]+\.json$/.test(rel)) return { label: "백업 설명 라벨", icon: "logs" };
  if (/^console\/jobs\/[^/]+\/[^/]+\.json$/.test(rel)) return { label: "작업 이력 레코드", icon: "logs" };
  if (/^console\/(?:plans|bundle-plans|claims|bundle-claims)\/[^/]+\.json$/.test(rel)) return { label: "복원 계획·승인", icon: "restore" };
  if (/^console\/schedule-[^/]+\/[^/]+\.json$/.test(rel)) return { label: "일일 백업 예약", icon: "calendar" };
  if (rel.startsWith("locks/") || rel.endsWith(".lock")) return { label: "범위 잠금", icon: "shield" };
  return { label: "Blob", icon: "logs" };
}

export function storageRootLabel(data) {
  if (!data) return "저장소";
  if (data.archiveMode === "local") return "로컬 저장소";
  if (data.archiveMode === "preview") return data.container || "armbackup";
  return data.container || "컨테이너";
}

export function storageSourceSummary(data) {
  if (!data) return "";
  if (data.archiveMode === "local") {
    return data.localPath ? `로컬 검증 디스크 · ${data.localPath}` : "로컬 검증 디스크";
  }
  if (data.archiveMode === "preview") {
    return `예시 컨테이너 · ${data.accountName || "preview"} / ${data.container || "armbackup"}`;
  }
  return data.accountName && data.container
    ? `${data.accountName} / ${data.container}`
    : data.container || "Azure Blob";
}

export function buildStorageIndex(data) {
  const configuredPrefix = data?.configuredPrefix || "";
  const rootName = storageRootLabel(data);
  const dirs = new Map();

  function ensureDir(path) {
    if (dirs.has(path)) return dirs.get(path);
    const slash = path.lastIndexOf("/");
    const parent = path === "" ? null : slash === -1 ? "" : path.slice(0, slash);
    const name = path === "" ? rootName : slash === -1 ? path : path.slice(slash + 1);
    const depth = path === "" ? 0 : path.split("/").length;
    const node = {
      path,
      name,
      parent,
      depth,
      roleLabel: classifyDirectory(path, configuredPrefix),
      totalBytes: 0,
      blobCount: 0,
      directBytes: 0,
      directBlobCount: 0,
      childDirs: [],
      directBlobs: [],
      lastModified: "",
    };
    dirs.set(path, node);
    if (parent !== null) {
      const parentNode = ensureDir(parent);
      if (!parentNode.childDirs.includes(path)) parentNode.childDirs.push(path);
    }
    return node;
  }

  ensureDir("");
  const blobs = [];
  for (const raw of data?.blobs || []) {
    const fullName = String(raw.name || "");
    if (!fullName) continue;
    const size = Math.max(0, Number(raw.size) || 0);
    const lastModified = typeof raw.lastModified === "string" ? raw.lastModified : "";
    const slash = fullName.lastIndexOf("/");
    const dirPath = slash === -1 ? "" : fullName.slice(0, slash);
    const baseName = slash === -1 ? fullName : fullName.slice(slash + 1);
    const role = classifyBlob(fullName, configuredPrefix);
    const blob = {
      name: fullName,
      baseName,
      dirPath,
      size,
      lastModified,
      contentType: raw.contentType || "",
      tier: raw.tier || "",
      roleLabel: role.label,
      icon: role.icon,
    };
    blobs.push(blob);
    const parentDir = ensureDir(dirPath);
    parentDir.directBlobs.push(blob);
    parentDir.directBytes += size;
    parentDir.directBlobCount += 1;
    let cursor = parentDir;
    while (cursor) {
      cursor.totalBytes += size;
      cursor.blobCount += 1;
      if (lastModified && (!cursor.lastModified || lastModified > cursor.lastModified)) {
        cursor.lastModified = lastModified;
      }
      cursor = cursor.parent === null ? null : dirs.get(cursor.parent);
    }
  }

  for (const dir of dirs.values()) {
    dir.childDirs.sort((left, right) => {
      const a = dirs.get(left);
      const b = dirs.get(right);
      return b.totalBytes - a.totalBytes || a.name.localeCompare(b.name, "en");
    });
    dir.directBlobs.sort((a, b) => b.size - a.size || a.baseName.localeCompare(b.baseName, "en"));
  }

  const root = dirs.get("");
  return {
    dirs,
    blobs,
    root,
    totalBytes: root.totalBytes,
    blobCount: root.blobCount,
    configuredPrefix,
    truncated: Boolean(data?.truncated),
    scanLimit: data?.scanLimit || 10000,
    prefix: data?.prefix || "",
  };
}

export function defaultCollapsedDirs(index) {
  const collapsed = new Set();
  const maxOpenDepth = index.configuredPrefix ? 2 : 1;
  for (const dir of index.dirs.values()) {
    if (!dir.path || !dir.childDirs.length) continue;
    if (dir.depth >= maxOpenDepth && (dir.depth > maxOpenDepth || dir.childDirs.length > 10)) {
      collapsed.add(dir.path);
    }
  }
  return collapsed;
}

export function defaultInitialScope(index) {
  if (!index?.root) return null;
  if (index.root.directBlobCount === 0 && index.root.childDirs.length === 1) {
    return index.root.childDirs[0];
  }
  return null;
}

export function defaultExpandedTableDirs(index) {
  const expanded = new Set([""]);
  const maxDepth = index.configuredPrefix ? 2 : 1;
  for (const dir of index.dirs.values()) {
    if (dir.path && dir.depth <= maxDepth && dir.childDirs.length <= 12) {
      expanded.add(dir.path);
    }
  }
  return expanded;
}

export function buildStoragePaneNodes(index) {
  const nodes = [];
  function visit(parentPath) {
    const parent = index.dirs.get(parentPath);
    if (!parent) return;
    for (const childPath of parent.childDirs) {
      const dir = index.dirs.get(childPath);
      const sizeText = formatBytes(dir.totalBytes);
      nodes.push({
        key: dir.path,
        parent: parentPath === "" ? null : parentPath,
        kind: `${dir.roleLabel} · ${dir.blobCount.toLocaleString("en-US")}개`,
        label: dir.name,
        icon: "folder",
        count: dir.blobCount,
        attention: 0,
        metaText: sizeText,
        metaLabel: `점유 크기 ${sizeText} (${exactBytes(dir.totalBytes)})`,
        title: `${dir.path} · Blob ${dir.blobCount.toLocaleString("en-US")}개 · ${sizeText} (${exactBytes(dir.totalBytes)})`,
      });
      visit(childPath);
    }
  }
  visit("");
  return nodes;
}

function compareItems(sort, left, right) {
  const leftSize = left.kind === "dir" ? left.dir.totalBytes : left.blob.size;
  const rightSize = right.kind === "dir" ? right.dir.totalBytes : right.blob.size;
  const leftName = left.kind === "dir" ? left.dir.path : left.blob.name;
  const rightName = right.kind === "dir" ? right.dir.path : right.blob.name;
  const leftTime = left.kind === "dir" ? left.dir.lastModified : left.blob.lastModified;
  const rightTime = right.kind === "dir" ? right.dir.lastModified : right.blob.lastModified;

  if (sort === "size-asc") {
    return leftSize - rightSize || leftName.localeCompare(rightName, "en");
  }
  if (sort === "name-asc") {
    if (left.kind !== right.kind) return left.kind === "dir" ? -1 : 1;
    return leftName.localeCompare(rightName, "en");
  }
  if (sort === "modified-desc") {
    return rightTime.localeCompare(leftTime) || rightSize - leftSize || leftName.localeCompare(rightName, "en");
  }
  return rightSize - leftSize || leftName.localeCompare(rightName, "en");
}

function relativeDisplayPath(fullPath, baseDir) {
  if (!baseDir) return fullPath;
  if (fullPath.startsWith(`${baseDir}/`)) return fullPath.slice(baseDir.length + 1);
  return fullPath;
}

export function visibleStorageRows(index, storageState) {
  const treeLayout = storageState.pane.open;
  const scopeDir = treeLayout && storageState.pane.scope && index.dirs.has(storageState.pane.scope)
    ? storageState.pane.scope
    : "";
  const query = storageState.query.trim().toLowerCase();
  const sort = storageState.sort || "size-desc";
  const mode = storageState.mode || "current";

  if (mode === "flat") {
    const prefixWithSlash = scopeDir ? `${scopeDir}/` : "";
    const matched = index.blobs
      .filter((blob) => (!scopeDir || blob.name.startsWith(prefixWithSlash))
        && (!query || `${blob.name} ${blob.roleLabel} ${blob.tier}`.toLowerCase().includes(query)))
      .map((blob) => ({
        id: `blob:${blob.name}`,
        kind: "blob",
        blob,
        displayName: relativeDisplayPath(blob.name, scopeDir),
        subPath: blob.dirPath ? `${blob.dirPath}/` : "(컨테이너 루트)",
        level: 1,
        parentId: null,
      }))
      .sort((a, b) => compareItems(sort, a, b));
    return { scopeDir, treeLayout, rows: matched };
  }

  if (!treeLayout) {
    const rows = [];
    function walkDir(dirPath, level, parentRowId) {
      const dir = index.dirs.get(dirPath);
      if (!dir) return;
      const orderedDirs = [...dir.childDirs]
        .map((path) => ({ kind: "dir", dir: index.dirs.get(path) }))
        .sort((a, b) => compareItems(sort, a, b));
      const orderedBlobs = [...dir.directBlobs]
        .map((blob) => ({ kind: "blob", blob }))
        .sort((a, b) => compareItems(sort, a, b));

      for (const { dir: child } of orderedDirs) {
        if (query && !hasQueryMatchInSubtree(index, child.path, query)) continue;
        const rowId = `scope:${child.path}`;
        const open = Boolean(query) || storageState.expandedDirs.has(child.path);
        rows.push({
          id: rowId,
          kind: "scope-dir",
          dir: child,
          level,
          expandable: child.childDirs.length > 0 || child.directBlobs.length > 0,
          open,
          parentId: parentRowId,
        });
        if (open) walkDir(child.path, level + 1, rowId);
      }

      for (const { blob } of orderedBlobs) {
        if (query && !`${blob.name} ${blob.roleLabel} ${blob.tier}`.toLowerCase().includes(query)) continue;
        rows.push({
          id: `blob:${blob.name}`,
          kind: "blob",
          blob,
          displayName: blob.baseName,
          subPath: blob.dirPath ? `${blob.dirPath}/` : "(컨테이너 루트)",
          level,
          parentId: parentRowId,
        });
      }
    }
    walkDir("", 1, null);
    return { scopeDir: "", treeLayout: false, rows };
  }

  const activeDir = index.dirs.get(scopeDir) || index.root;
  if (query) {
    const prefixWithSlash = scopeDir ? `${scopeDir}/` : "";
    const matchingDirs = [...index.dirs.values()]
      .filter((dir) => dir.path && (!scopeDir || dir.path.startsWith(prefixWithSlash))
        && `${dir.path} ${dir.roleLabel}`.toLowerCase().includes(query))
      .map((dir) => ({
        id: `dir:${dir.path}`,
        kind: "dir",
        dir,
        displayName: relativeDisplayPath(dir.path, scopeDir),
        subPath: `${dir.path}/`,
        level: 1,
        parentId: null,
      }));
    const matchingBlobs = index.blobs
      .filter((blob) => (!scopeDir || blob.name.startsWith(prefixWithSlash))
        && `${blob.name} ${blob.roleLabel} ${blob.tier}`.toLowerCase().includes(query))
      .map((blob) => ({
        id: `blob:${blob.name}`,
        kind: "blob",
        blob,
        displayName: relativeDisplayPath(blob.name, scopeDir),
        subPath: blob.dirPath ? `${blob.dirPath}/` : "(컨테이너 루트)",
        level: 1,
        parentId: null,
      }));
    return {
      scopeDir,
      treeLayout: true,
      rows: [...matchingDirs, ...matchingBlobs].sort((a, b) => compareItems(sort, a, b)),
    };
  }

  const items = [
    ...activeDir.childDirs.map((path) => {
      const dir = index.dirs.get(path);
      return {
        id: `dir:${dir.path}`,
        kind: "dir",
        dir,
        displayName: dir.name,
        subPath: `${dir.path}/`,
        level: 1,
        parentId: null,
      };
    }),
    ...activeDir.directBlobs.map((blob) => ({
      id: `blob:${blob.name}`,
      kind: "blob",
      blob,
      displayName: blob.baseName,
      subPath: blob.dirPath ? `${blob.dirPath}/` : "(컨테이너 루트)",
      level: 1,
      parentId: null,
    })),
  ].sort((a, b) => compareItems(sort, a, b));

  return { scopeDir, treeLayout: true, rows: items };
}

function hasQueryMatchInSubtree(index, dirPath, query) {
  const dir = index.dirs.get(dirPath);
  if (!dir) return false;
  if (`${dir.path} ${dir.roleLabel}`.toLowerCase().includes(query)) return true;
  const prefix = `${dirPath}/`;
  return index.blobs.some(
    (blob) => blob.name.startsWith(prefix) && `${blob.name} ${blob.roleLabel} ${blob.tier}`.toLowerCase().includes(query),
  ) || [...index.dirs.values()].some(
    (child) => child.path.startsWith(prefix) && `${child.path} ${child.roleLabel}`.toLowerCase().includes(query),
  );
}

export function storageTopbarHtml(storageState, { esc, icon, busy = false }) {
  const data = storageState.data;
  const truncatedBadge = data?.truncated
    ? `<span class="storage-topbar-meta"><span class="count-pill" title="집계 한도 ${data.scanLimit.toLocaleString("en-US")}개 도달 · 표시된 합계 ${esc(exactBytes(data.totalBytes))}">최소 ${esc(formatBytes(data.totalBytes))} · ${data.blobCount.toLocaleString("en-US")}+개</span></span>`
    : "";
  const disabled = busy || storageState.loading ? "disabled" : "";
  return `${truncatedBadge}<button class="button" type="button" data-action="storage-refresh" ${disabled}>${icon("refresh")}새로고침</button>`;
}

export function storageBreadcrumbHtml(index, storageState, { esc, icon }) {
  const scopeDir = storageState.pane.open && storageState.pane.scope && index.dirs.has(storageState.pane.scope)
    ? storageState.pane.scope
    : "";
  const activeDir = index.dirs.get(scopeDir) || index.root;
  const rootName = index.root.name;
  const segments = scopeDir ? scopeDir.split("/") : [];
  let cursor = "";
  const crumbs = [
    scopeDir
      ? `<li><button type="button" class="storage-crumb" data-action="storage-dir" data-dir="">${icon("storage")}<span>${esc(rootName)}</span></button></li>`
      : `<li aria-current="location"><span class="storage-crumb-current">${icon("storage")}<strong>${esc(rootName)}</strong></span></li>`,
  ];
  segments.forEach((segment, idx) => {
    cursor = cursor ? `${cursor}/${segment}` : segment;
    const isLast = idx === segments.length - 1;
    crumbs.push(isLast
      ? `<li aria-current="location"><strong class="storage-crumb-current">${esc(segment)}</strong></li>`
      : `<li><button type="button" class="storage-crumb" data-action="storage-dir" data-dir="${esc(cursor)}">${esc(segment)}</button></li>`);
  });

  const share = formatShare(activeDir.totalBytes, index.totalBytes);
  const shareNote = scopeDir ? ` · 컨테이너 대비 ${share.text}` : "";
  const parentDir = activeDir.parent ?? "";
  const upButton = scopeDir
    ? `<button type="button" class="tree-scope-clear" data-action="storage-dir" data-dir="${esc(parentDir)}" aria-label="상위 디렉터리로 이동">${icon("arrow")}<span>상위 폴더</span></button>`
    : "";
  const narrowFetch = index.truncated && scopeDir && scopeDir !== index.prefix
    ? `<button type="button" class="tree-scope-clear" data-action="storage-query-prefix" data-prefix="${esc(scopeDir)}">${icon("search")}<span>이 경로만 정밀 조회</span></button>`
    : index.prefix
      ? `<button type="button" class="tree-scope-clear" data-action="storage-query-prefix" data-prefix="">${icon("close")}<span>전체 컨테이너 조회</span></button>`
      : "";

  return `<div class="tree-scope-bar storage-scope-bar" role="navigation" aria-label="저장소 현재 경로">`
    + `<ol>${crumbs.join("")}</ol>`
    + `<span class="tree-scope-count storage-dir-stats" title="${esc(exactBytes(activeDir.totalBytes))}">하위 폴더 ${activeDir.childDirs.length.toLocaleString("en-US")}개 · Blob ${activeDir.blobCount.toLocaleString("en-US")}개 · <strong>${esc(formatBytes(activeDir.totalBytes))}</strong>${esc(shareNote)}</span>`
    + `${narrowFetch}${upButton}</div>`;
}

function sizeBarSvg(pct) {
  const width = Math.max(0, Math.min(100, Number(pct) || 0));
  return `<svg class="size-bar" viewBox="0 0 100 6" preserveAspectRatio="none" aria-hidden="true">`
    + `<rect class="size-bar-track" x="0" y="0" width="100" height="6" rx="3"/>`
    + `${width > 0 ? `<rect class="size-bar-fill" x="0" y="0" width="${width}" height="6" rx="3"/>` : ""}</svg>`;
}

export function storageTableHtml(index, storageState, { esc, icon, date, timezone }) {
  const { scopeDir, treeLayout, rows } = visibleStorageRows(index, storageState);
  const scopeNode = index.dirs.get(scopeDir) || index.root;
  const denominator = treeLayout && scopeDir ? scopeNode.totalBytes : index.totalBytes;
  const shareColumnTitle = treeLayout && scopeDir ? "경로 내 비율" : "컨테이너 비율";
  const timeParts = (iso) => {
    if (!iso) return { day: "미확인", clock: "타임스탬프 없음" };
    const formatted = String(date(iso));
    const space = formatted.indexOf(" ");
    return space === -1
      ? { day: formatted, clock: timezone }
      : { day: formatted.slice(0, space), clock: `${formatted.slice(space + 1)} ${timezone}` };
  };

  if (!index.blobCount) {
    return `<div class="empty-state">${icon("storage")}<strong>컨테이너에 저장된 Blob이 없습니다</strong>저장소 조회는 정상 완료되었으나 현재 보관된 백업·캐시 Blob이 0개입니다.${index.prefix ? `<p><button class="button" type="button" data-action="storage-query-prefix" data-prefix="">전체 컨테이너 다시 조회</button></p>` : ""}</div>`;
  }

  if (!rows.length) {
    if (storageState.query.trim()) {
      return `<div class="empty-state">${icon("search")}<strong>검색 조건에 맞는 디렉터리·Blob이 없습니다</strong>입력한 검색어 “${esc(storageState.query.trim())}”와 일치하는 항목이 현재 범위에 없습니다.<p><button class="button" type="button" data-action="storage-clear-search">검색 초기화</button></p></div>`;
    }
    return `<div class="empty-state">${icon("folder")}<strong>이 디렉터리에는 직접 표시할 항목이 없습니다</strong>왼쪽 디렉터리 계층이나 상위 폴더로 이동해 확인해 주세요.</div>`;
  }

  if (!rows.some((row) => row.id === storageState.focusId)) {
    storageState.focusId = rows[0].id;
  }

  const indent = (depth) => (depth > 0 ? `<span class="scope-indent" aria-hidden="true">${"<span></span>".repeat(depth)}</span>` : "");

  const body = rows.map((row, indexPos) => {
    const focused = storageState.focusId === row.id;
    const common = `data-storage-row="${esc(row.id)}" tabindex="${focused ? 0 : -1}" role="row" aria-level="${row.level}" aria-rowindex="${indexPos + 2}"`;

    if (row.kind === "scope-dir") {
      const dir = row.dir;
      const share = formatShare(dir.totalBytes, index.totalBytes);
      const toggle = row.expandable
        ? `<button class="tree-toggle ${row.open ? "open" : ""}" type="button" data-action="storage-toggle-dir" data-dir="${esc(dir.path)}" aria-label="${esc(dir.path)} ${row.open ? "접기" : "펼치기"}" tabindex="-1">${icon("chevron")}</button>`
        : "";
      return `<tbody class="tree-grid-group"><tr ${common} class="scope-row storage-scope-row" aria-expanded="${row.open}" data-action="storage-toggle-row" data-dir="${esc(dir.path)}">`
        + `<td role="gridcell" colspan="5" data-tree-depth="${Math.min(row.level - 1, 4)}"><div class="scope-cell storage-scope-cell">${indent(row.level - 1)}${toggle}${icon("folder")}<span class="scope-name" title="${esc(dir.path)}">${esc(dir.name)}</span><span class="count-pill">Blob ${dir.blobCount.toLocaleString("en-US")}개</span><span class="scope-kind">${esc(dir.roleLabel)}</span><span class="storage-scope-size mono" title="${esc(exactBytes(dir.totalBytes))}">${esc(formatBytes(dir.totalBytes))} · ${esc(share.text)}</span></div></td></tr></tbody>`;
    }

    if (row.kind === "dir") {
      const dir = row.dir;
      const share = formatShare(dir.totalBytes, denominator);
      const containerShare = scopeDir && denominator !== index.totalBytes ? formatShare(dir.totalBytes, index.totalBytes) : null;
      const stamp = timeParts(dir.lastModified);
      return `<tbody class="resource-group"><tr ${common} class="resource-row storage-dir-row" data-action="storage-open-dir" data-dir="${esc(dir.path)}">`
        + `<td role="gridcell"><div class="resource-identity"><span class="resource-symbol storage">${icon("folder")}</span><span class="resource-name-wrap"><span class="resource-name-line"><span class="resource-name storage-item-name" title="${esc(dir.path)}/">${esc(row.displayName)}/</span></span><span class="resource-region mono">${esc(dir.childDirs.length ? `하위 폴더 ${dir.childDirs.length}개 · 직접 Blob ${dir.directBlobCount}개` : `직접 Blob ${dir.directBlobCount}개`)}</span></span></div></td>`
        + `<td role="gridcell"><span class="type-text">${esc(dir.roleLabel)}</span><span class="table-sub">누적 Blob ${dir.blobCount.toLocaleString("en-US")}개</span></td>`
        + `<td role="gridcell" class="num-cell"><span class="storage-bytes-main mono">${esc(formatBytes(dir.totalBytes))}</span>${dir.totalBytes >= 1024 ? `<span class="table-sub mono">${esc(exactBytes(dir.totalBytes))}</span>` : ""}</td>`
        + `<td role="gridcell"><div class="size-share-cell">${sizeBarSvg(share.pct)}<span class="size-share-text mono">${esc(share.text)}</span></div>${containerShare ? `<span class="table-sub mono">전체 대비 ${esc(containerShare.text)}</span>` : `<span class="table-sub">하위 전체 합산</span>`}</td>`
        + `<td role="gridcell"><time class="table-time" datetime="${esc(dir.lastModified)}">${esc(stamp.day)}</time><span class="table-sub mono">${esc(stamp.clock)}</span></td>`
        + `</tr></tbody>`;
    }

    const blob = row.blob;
    const share = formatShare(blob.size, denominator);
    const containerShare = scopeDir && denominator !== index.totalBytes ? formatShare(blob.size, index.totalBytes) : null;
    const shortType = blob.contentType === "application/json" ? "JSON"
      : blob.contentType === "application/octet-stream" ? "Binary"
        : blob.contentType;
    const metaParts = [blob.tier, shortType].filter(Boolean);
    const stamp = timeParts(blob.lastModified);
    return `<tbody class="resource-group"><tr ${common} class="resource-row storage-blob-row" data-action="storage-inspect-blob" data-blob="${esc(blob.name)}">`
      + `<td role="gridcell"><div class="resource-identity"><span class="resource-symbol network">${icon(blob.icon)}</span><span class="resource-name-wrap"><span class="resource-name-line"><span class="resource-name storage-item-name mono" title="${esc(blob.name)}">${esc(row.displayName)}</span></span>${storageState.mode === "flat" || storageState.query.trim() ? `<span class="resource-region mono" title="${esc(row.subPath)}">${esc(row.subPath)}</span>` : ""}</span></div></td>`
      + `<td role="gridcell"><span class="type-text">${esc(blob.roleLabel)}</span><span class="table-sub">${esc(metaParts.length ? metaParts.join(" · ") : "개별 Blob")}</span></td>`
      + `<td role="gridcell" class="num-cell"><span class="storage-bytes-main mono">${esc(formatBytes(blob.size))}</span>${blob.size >= 1024 ? `<span class="table-sub mono">${esc(exactBytes(blob.size))}</span>` : ""}</td>`
      + `<td role="gridcell"><div class="size-share-cell">${sizeBarSvg(share.pct)}<span class="size-share-text mono">${esc(share.text)}</span></div>${containerShare ? `<span class="table-sub mono">전체 대비 ${esc(containerShare.text)}</span>` : `<span class="table-sub">개별 객체</span>`}</td>`
      + `<td role="gridcell"><time class="table-time" datetime="${esc(blob.lastModified)}">${esc(stamp.day)}</time><span class="table-sub mono">${esc(stamp.clock)}</span></td>`
      + `</tr></tbody>`;
  }).join("");

  return `<table class="resource-table storage-table tree-grid" role="treegrid" aria-label="저장소 디렉터리 및 Blob별 점유 크기" aria-colcount="5" aria-rowcount="${rows.length + 1}">`
    + `<colgroup><col class="storage-name-col"><col class="storage-kind-col"><col class="storage-size-col"><col class="storage-share-col"><col class="storage-time-col"></colgroup>`
    + `<thead><tr role="row" aria-rowindex="1">`
    + `<th role="columnheader">디렉터리 · Blob 이름</th>`
    + `<th role="columnheader">구분 · 용도</th>`
    + `<th role="columnheader" class="num-head">점유 크기</th>`
    + `<th role="columnheader">${esc(shareColumnTitle)}</th>`
    + `<th role="columnheader">최근 수정</th>`
    + `</tr></thead>${body}</table>`;
}

export function storageShellHtml(storageState, { esc, icon }) {
  if (!storageState.data && storageState.loading) {
    return `<h1 class="sr-only">백업 저장소 탐색</h1>`
      + `<section class="panel status-panel storage-panel" aria-label="백업 저장소 용량 탐색">`
      + `<div class="initial-loading" role="status"><span class="spinner" aria-hidden="true"></span><span>저장소 디렉터리와 Blob 크기를 집계하고 있습니다…</span></div>`
      + `</section>`;
  }
  if (!storageState.data && storageState.error) {
    return `<h1 class="sr-only">백업 저장소 탐색</h1>`
      + `<section class="panel status-panel storage-panel" aria-label="백업 저장소 용량 탐색">`
      + `<div class="empty-state">${icon("alert")}<strong>저장소 목록을 조회하지 못했습니다</strong>${esc(storageState.error)}<p><button class="button" type="button" data-action="storage-refresh">${icon("refresh")}다시 조회</button></p></div>`
      + `</section>`;
  }
  return `<h1 class="sr-only">백업 저장소 탐색</h1>`
    + `<section class="panel status-panel storage-panel" aria-label="백업 저장소 디렉터리 및 Blob 용량 탐색">`
    + `<div class="toolbar storage-toolbar">`
    + `<label class="search-field">${icon("search")}<input type="search" id="storage-search" aria-label="디렉터리 및 Blob 경로 검색" value="${esc(storageState.query)}" placeholder="경로, 실행 ID, 디렉터리·Blob 이름 검색"></label>`
    + `<select id="storage-mode" class="filter-select storage-select" aria-label="표시 단위">`
    + `<option value="current" ${storageState.mode === "current" ? "selected" : ""}>현재 경로 항목 (폴더+Blob)</option>`
    + `<option value="flat" ${storageState.mode === "flat" ? "selected" : ""}>하위 전체 Blob 목록</option>`
    + `</select>`
    + `<select id="storage-sort" class="filter-select storage-select" aria-label="정렬 기준">`
    + `<option value="size-desc" ${storageState.sort === "size-desc" ? "selected" : ""}>점유 크기 큰 순</option>`
    + `<option value="size-asc" ${storageState.sort === "size-asc" ? "selected" : ""}>점유 크기 작은 순</option>`
    + `<option value="modified-desc" ${storageState.sort === "modified-desc" ? "selected" : ""}>최근 수정 순</option>`
    + `<option value="name-asc" ${storageState.sort === "name-asc" ? "selected" : ""}>이름·경로 순</option>`
    + `</select>`
    + `</div>`
    + `<div class="tree-area" id="storage-tree-area">`
    + `<aside class="tree-pane" id="storage-tree-pane" aria-label="디렉터리 계층"></aside>`
    + `<div class="tree-area-main"><div id="storage-scope"></div><div class="table-scroll tree-grid-scroll" id="storage-table-container"></div></div>`
    + `</div>`
    + `<div class="selection-toolbar storage-footer"><span id="storage-footer-hint"></span></div>`
    + `</section>`;
}

export function storageFooterText(index, storageState, { date, timezone }) {
  if (!index || !storageState.data) return "";
  const data = storageState.data;
  const observed = data.observedAt ? `${date(data.observedAt)} ${timezone} 집계` : "";
  const modeNote = data.archiveMode === "local"
    ? `로컬 검증 디스크 (${data.localPath || "경로 미상"})`
    : data.archiveMode === "preview"
      ? `예시 컨테이너 (${data.container || "armbackup"}) · 브라우저 예시 데이터`
      : `컨테이너 ${data.accountName ? `${data.accountName} / ` : ""}${data.container}`;
  const prefixNote = data.prefix ? ` · 조회 범위 ${data.prefix}/` : "";
  const limitNote = data.truncated ? ` · 처음 ${data.scanLimit.toLocaleString("en-US")}개까지만 집계됨` : "";
  return `${modeNote}${prefixNote} · 읽기 전용 탐색${observed ? ` · ${observed}` : ""}${limitNote}`;
}

export function blobDetailDialogHtml(index, blobName, { esc, date, timezone }) {
  const blob = index?.blobs.find((entry) => entry.name === blobName);
  if (!blob) return `<p>선택한 Blob 정보를 찾을 수 없습니다.</p>`;
  const parentDir = index.dirs.get(blob.dirPath) || index.root;
  const containerShare = formatShare(blob.size, index.totalBytes);
  const dirShare = formatShare(blob.size, parentDir.totalBytes);
  return `<dl class="summary-list storage-detail-list">`
    + `<dt>전체 경로</dt><dd><code class="resource-id">${esc(blob.name)}</code></dd>`
    + `<dt>소속 디렉터리</dt><dd class="mono">${esc(blob.dirPath ? `${blob.dirPath}/` : "(컨테이너 루트)")}</dd>`
    + `<dt>구분 · 용도</dt><dd>${esc(blob.roleLabel)}</dd>`
    + `<dt>점유 크기</dt><dd class="mono"><strong>${esc(formatBytes(blob.size))}</strong> (${esc(exactBytes(blob.size))})</dd>`
    + `<dt>디렉터리 내 비율</dt><dd class="mono">${esc(dirShare.text)} (디렉터리 합계 ${esc(formatBytes(parentDir.totalBytes))})</dd>`
    + `<dt>컨테이너 내 비율</dt><dd class="mono">${esc(containerShare.text)} (전체 ${esc(formatBytes(index.totalBytes))})</dd>`
    + `<dt>최근 수정 (${esc(timezone)})</dt><dd class="mono">${blob.lastModified ? esc(date(blob.lastModified)) : "미확인"}</dd>`
    + `<dt>UTC 시각</dt><dd class="mono">${esc(blob.lastModified || "미확인")}</dd>`
    + `${blob.tier ? `<dt>액세스 계층</dt><dd>${esc(blob.tier)}</dd>` : ""}`
    + `${blob.contentType ? `<dt>Content-Type</dt><dd class="mono">${esc(blob.contentType)}</dd>` : ""}`
    + `</dl>`;
}

export function selectStorageDirectory(index, storageState, dirPath) {
  const clean = dirPath && index?.dirs.has(dirPath) ? dirPath : "";
  storageState.pane.scope = clean || null;
  storageState.pane.focusKey = clean;
  storageState.focusId = "";
  if (clean) {
    let cursor = clean;
    while (cursor) {
      const node = index.dirs.get(cursor);
      if (node?.parent) storageState.pane.collapsed.delete(node.parent);
      cursor = node?.parent || "";
    }
  }
}

export function toggleStorageTableDir(storageState, dirPath) {
  if (!dirPath) return;
  if (storageState.expandedDirs.has(dirPath)) storageState.expandedDirs.delete(dirPath);
  else storageState.expandedDirs.add(dirPath);
  storageState.focusId = `scope:${dirPath}`;
}

export function focusStorageRow(root, storageState, rowId) {
  const rows = [...root.querySelectorAll("[data-storage-row]")];
  const target = (rowId && rows.find((el) => el.dataset.storageRow === rowId)) || rows[0];
  if (!target) return;
  storageState.focusId = target.dataset.storageRow;
  for (const el of rows) el.tabIndex = el === target ? 0 : -1;
  target.focus({ preventScroll: true });
  target.scrollIntoView({ block: "nearest" });
}

export function handleStorageTableKey(event, root, index, storageState, { rerender, inspectBlob }) {
  const element = event.target?.closest?.("[data-storage-row]");
  if (!element || event.target !== element || !index) return false;
  const { rows } = visibleStorageRows(index, storageState);
  const pos = rows.findIndex((row) => row.id === element.dataset.storageRow);
  if (pos === -1) return false;
  const row = rows[pos];
  let nextId = "";

  if (event.key === "ArrowDown") {
    nextId = rows[Math.min(pos + 1, rows.length - 1)].id;
  } else if (event.key === "ArrowUp") {
    nextId = rows[Math.max(pos - 1, 0)].id;
  } else if (event.key === "Home") {
    nextId = rows[0].id;
  } else if (event.key === "End") {
    nextId = rows.at(-1).id;
  } else if (event.key === "ArrowRight") {
    if (row.kind === "scope-dir" && row.expandable) {
      if (!row.open) {
        storageState.expandedDirs.add(row.dir.path);
        event.preventDefault();
        rerender();
        focusStorageRow(root, storageState, row.id);
        return true;
      }
      nextId = rows[pos + 1]?.id || row.id;
    } else if (row.kind === "dir") {
      event.preventDefault();
      selectStorageDirectory(index, storageState, row.dir.path);
      rerender();
      focusStorageRow(root, storageState, "");
      return true;
    } else {
      return false;
    }
  } else if (event.key === "ArrowLeft") {
    if (row.kind === "scope-dir" && row.open) {
      storageState.expandedDirs.delete(row.dir.path);
      event.preventDefault();
      rerender();
      focusStorageRow(root, storageState, row.id);
      return true;
    }
    if (row.parentId) {
      nextId = row.parentId;
    } else if (storageState.pane.open && storageState.pane.scope) {
      const current = index.dirs.get(storageState.pane.scope);
      const prevScope = storageState.pane.scope;
      event.preventDefault();
      selectStorageDirectory(index, storageState, current?.parent || "");
      rerender();
      focusStorageRow(root, storageState, `dir:${prevScope}`);
      return true;
    } else {
      return false;
    }
  } else if (event.key === "Enter" || event.key === " ") {
    event.preventDefault();
    if (row.kind === "scope-dir") {
      toggleStorageTableDir(storageState, row.dir.path);
      rerender();
      focusStorageRow(root, storageState, row.id);
    } else if (row.kind === "dir") {
      selectStorageDirectory(index, storageState, row.dir.path);
      rerender();
      focusStorageRow(root, storageState, "");
    } else if (row.kind === "blob") {
      storageState.focusId = row.id;
      inspectBlob(row.blob.name);
    }
    return true;
  } else {
    return false;
  }

  event.preventDefault();
  if (nextId) focusStorageRow(root, storageState, nextId);
  return true;
}

