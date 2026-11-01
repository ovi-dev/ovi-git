// @ts-check
(function () {
  // @ts-ignore provided by the VS Code webview host
  const vscode = acquireVsCodeApi();
  /** @type {any} */
  let state = null;
  const $ = (/** @type {string} */ id) =>
    /** @type {HTMLElement} */ (document.getElementById(id));

  function el(
    /** @type {string} */ tag,
    /** @type {string} */ className,
    /** @type {string} */ text,
  ) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    node.textContent = text;
    return node;
  }

  function setBusy(busy) {
    document
      .querySelectorAll("button, input, textarea, select")
      .forEach((node) => {
        /** @type {HTMLInputElement | HTMLButtonElement | HTMLTextAreaElement | HTMLSelectElement} */ (
          node
        ).disabled = busy;
      });
  }

  function render(data) {
    state = data;
    setBusy(false);
    const hasRepository = data.repositories.length > 0;
    $("empty").hidden = hasRepository;
    $("workspace").hidden = !hasRepository;
    if (!hasRepository) return;

    const repository = /** @type {HTMLSelectElement} */ ($("repository"));
    repository.textContent = "";
    for (const item of data.repositories) {
      const option = document.createElement("option");
      option.value = item.root;
      option.textContent = item.name;
      option.selected = item.root === data.root;
      repository.appendChild(option);
    }

    $("currentBranch").textContent =
      data.head.branch ??
      `HEAD separado · ${(data.head.hash ?? "").slice(0, 7)}`;
    renderSync(data);
    renderFiles("changes", data.changes, "openWorkingFile");
    $("changeCount").textContent = String(data.changes.length);
    $("clean").hidden = data.changes.length > 0;
    $("commitForm").hidden = data.changes.length === 0;

    const branches = $("branches");
    branches.textContent = "";
    $("branchCount").textContent = String(data.branches.length);
    for (const branch of data.branches) {
      const row = el(
        "div",
        `branch${branch.name === data.head.branch ? " current" : ""}`,
        "",
      );
      const select = el("button", "branch-name", branch.name);
      select.title = `Ver archivos que aporta ${branch.name}`;
      select.addEventListener("click", () => {
        document
          .querySelectorAll(".branch.selected")
          .forEach((item) => item.classList.remove("selected"));
        row.classList.add("selected");
        setBusy(true);
        vscode.postMessage({ type: "selectBranch", name: branch.name });
      });
      row.appendChild(select);
      if (branch.type === "head" && branch.name !== data.head.branch) {
        const checkout = el("button", "checkout", "Cambiar");
        checkout.title = `Cambiar a ${branch.name}`;
        checkout.addEventListener("click", () => {
          setBusy(true);
          vscode.postMessage({ type: "switchBranch", name: branch.name });
        });
        row.appendChild(checkout);
      }
      branches.appendChild(row);
    }
    $("branchDetail").hidden = true;
  }

  function renderSync(data) {
    const { upstream, ahead, behind } = data.sync;
    const canPush = data.hasRemote && !!data.head.branch;
    $("syncActions").hidden = !data.hasRemote;
    $("syncInfo").textContent = !data.hasRemote
      ? "Sin remoto configurado"
      : !data.head.branch
        ? ""
        : upstream
          ? ahead || behind
            ? `${upstream} · ↑${ahead} ↓${behind}`
            : `${upstream} · al día`
          : "Rama sin publicar";
    $("pull").textContent = behind ? `Pull ↓${behind}` : "Pull";
    $("push").textContent = upstream
      ? ahead
        ? `Push ↑${ahead}`
        : "Push"
      : "Publicar";
    $("push").classList.toggle("primary", ahead > 0 || (canPush && !upstream));
    /** @type {HTMLButtonElement} */ ($("pull")).disabled = !upstream;
    /** @type {HTMLButtonElement} */ ($("push")).disabled = !canPush;
    /** @type {HTMLButtonElement} */ ($("commitPushButton")).disabled =
      !canPush;
  }

  function renderFiles(containerId, files, messageType) {
    const container = $(containerId);
    container.textContent = "";
    files.forEach((file, index) => {
      const row = el("button", "file", "");
      row.title = "Abrir diff";
      row.appendChild(el("span", `status status-${file.status}`, file.status));
      row.appendChild(
        el(
          "span",
          "file-path",
          file.oldPath ? `${file.oldPath} → ${file.path}` : file.path,
        ),
      );
      if (file.staged) row.appendChild(el("span", "staged", "S"));
      row.addEventListener("click", () =>
        vscode.postMessage({ type: messageType, index }),
      );
      container.appendChild(row);
    });
  }

  $("repository").addEventListener("change", (event) => {
    setBusy(true);
    vscode.postMessage({
      type: "repository",
      root: /** @type {HTMLSelectElement} */ (event.target).value,
    });
  });
  $("refresh").addEventListener("click", () => {
    setBusy(true);
    vscode.postMessage({ type: "refresh" });
  });
  $("openGraph").addEventListener("click", () =>
    vscode.postMessage({ type: "openGraph" }),
  );
  $("openFolder").addEventListener("click", () =>
    vscode.postMessage({ type: "openFolder" }),
  );
  $("toggleCreate").addEventListener("click", () => {
    $("createForm").hidden = !$("createForm").hidden;
    if (!$("createForm").hidden)
      /** @type {HTMLInputElement} */ ($("branchName")).focus();
  });
  $("createForm").addEventListener("submit", (event) => {
    event.preventDefault();
    const input = /** @type {HTMLInputElement} */ ($("branchName"));
    if (!input.value.trim()) return;
    setBusy(true);
    vscode.postMessage({ type: "createBranch", name: input.value });
  });
  $("commitForm").addEventListener("submit", (event) => {
    event.preventDefault();
    submitCommit(false);
  });
  $("commitPushButton").addEventListener("click", () => submitCommit(true));
  $("commitMessage").addEventListener("keydown", (event) => {
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      submitCommit(false);
    }
  });
  for (const type of ["fetch", "pull", "push"]) {
    $(type).addEventListener("click", () => {
      setBusy(true);
      vscode.postMessage({ type });
    });
  }

  function submitCommit(push) {
    const input = /** @type {HTMLTextAreaElement} */ ($("commitMessage"));
    if (!input.value.trim()) return;
    setBusy(true);
    vscode.postMessage({ type: "commit", message: input.value, push });
  }

  window.addEventListener("message", (event) => {
    const message = event.data;
    if (message.type === "data") render(message);
    else if (message.type === "branchDetail") {
      setBusy(false);
      $("branchDetail").hidden = false;
      $("branchTitle").textContent = message.name;
      $("branchFileCount").textContent = String(message.files.length);
      renderFiles("branchFiles", message.files, "openBranchFile");
      $("branchClean").hidden = message.files.length > 0;
      $("branchDetail").scrollIntoView({ block: "start", behavior: "smooth" });
    } else if (message.type === "mutationDone") {
      if (message.operation === "createBranch") {
        /** @type {HTMLInputElement} */ ($("branchName")).value = "";
        $("createForm").hidden = true;
      } else if (message.operation === "commit") {
        /** @type {HTMLTextAreaElement} */ ($("commitMessage")).value = "";
      }
    } else if (message.type === "idle") setBusy(false);
  });

  vscode.postMessage({ type: "ready" });
})();
