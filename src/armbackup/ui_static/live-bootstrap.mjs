const retryKey = "armbackup.module-reload.v1";

async function loadConsole() {
  try {
    await import("./live-app.mjs");
  } catch (error) {
    console.error("Console modules failed to load", error);
    let retry = false;
    try {
      retry = window.sessionStorage.getItem(retryKey) !== "retried";
      if (retry) window.sessionStorage.setItem(retryKey, "retried");
    } catch (storageError) {
      retry = false;
      console.warn("Cannot persist the automatic reload limit", storageError);
    }
    const errors = createNotifications(document);
    errors.show(`화면 모듈을 불러오지 못했습니다. ${error instanceof Error ? error.message : String(error)}\n${retry
      ? "잠시 후 자동으로 새로고침합니다."
      : "연결 상태를 확인한 뒤 페이지를 새로고침해 주세요."}`,
    [{ label: "페이지 새로고침", run: () => window.location.reload() }]);
    document.querySelector("#main").replaceChildren();
    // A new document retries failed module dependencies, which imports cache by URL.
    if (retry) setTimeout(() => window.location.reload(), 1500);
    return;
  }
  try { window.sessionStorage.removeItem(retryKey); }
  catch (error) { console.warn("Cannot clear the automatic reload limit", error); }
}

loadConsole();
import { createNotifications } from "./notifications.mjs";
