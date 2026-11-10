export function loginMessage(status, retryAfter = "") {
  if (status === 401) return "아이디 또는 비밀번호가 올바르지 않습니다.";
  if (status === 429) {
    const seconds = Number.parseInt(retryAfter, 10);
    const wait = Number.isFinite(seconds) && seconds > 0 ? `${Math.ceil(seconds / 60)}분 후` : "잠시 후";
    return `로그인 시도가 너무 많습니다. ${wait} 다시 시도하세요.`;
  }
  if (status === 403) return "접근이 거부되었습니다. 지정된 주소로 접속했는지 확인하세요.";
  return "로그인하지 못했습니다. 잠시 후 다시 시도하세요.";
}

if (typeof document !== "undefined") {
  const form = document.querySelector("#login-form");
  const error = document.querySelector("#login-error");
  const submit = document.querySelector("#login-submit");
  const password = document.querySelector("#login-password");
  const show = (message) => { error.textContent = message; error.hidden = !message; };
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const username = document.querySelector("#login-username").value.trim();
    if (!username || !password.value) { show("아이디와 비밀번호를 입력하세요."); return; }
    submit.disabled = true;
    show("");
    try {
      const response = await fetch("/api/login", {
        method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ username, password: password.value }),
        credentials: "same-origin", cache: "no-store",
      });
      if (response.ok) { location.replace("/"); return; }
      show(loginMessage(response.status, response.headers.get("Retry-After") || ""));
    } catch {
      show("서버에 연결하지 못했습니다. 네트워크를 확인하고 다시 시도하세요.");
    }
    password.value = "";
    password.focus();
    submit.disabled = false;
  });
}
