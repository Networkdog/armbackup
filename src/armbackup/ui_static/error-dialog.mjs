export function createErrorDialog(root) {
  const message = root.querySelector("#error-message");
  const actions = root.querySelector("#error-actions");
  let dismissed = "";
  function dismiss() {
    dismissed = message.textContent;
    root.close();
  }
  root.querySelector("#error-close").addEventListener("click", dismiss);
  root.addEventListener("cancel", () => { dismissed = message.textContent; });
  root.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    event.preventDefault();
    event.stopPropagation();
    dismiss();
  });
  return {
    get open() { return root.open; },
    show(text, recovery = [], { background = false } = {}) {
      if ((background && dismissed === text) || (root.open && message.textContent === text)) return;
      dismissed = "";
      message.textContent = text;
      const controls = recovery.map((action) => {
        const control = root.ownerDocument.createElement(action.href ? "a" : "button");
        control.className = "button";
        control.textContent = action.label;
        if (action.href) control.href = action.href;
        else {
          control.type = "button";
          control.addEventListener("click", () => { root.close(); action.run(); });
        }
        return control;
      });
      const confirm = root.ownerDocument.createElement("button");
      confirm.className = "button primary";
      confirm.type = "button";
      confirm.textContent = "확인";
      confirm.addEventListener("click", dismiss);
      actions.replaceChildren(...controls, confirm);
      if (!root.open) root.showModal();
    },
    clear() {
      dismissed = "";
      if (root.open) root.close();
    },
  };
}
