import * as crypto from "crypto";
import * as path from "path";
import * as vscode from "vscode";
import { revisionUri } from "./contentProvider";
import { BranchComparison, Git, Ref, WorkingChange } from "./git";
import { GraphPanel } from "./panel";

interface RepositoryItem {
  name: string;
  root: string;
}

export class WorkspaceViewProvider implements vscode.WebviewViewProvider {
  static readonly viewType = "oviGit.workspace";

  private view: vscode.WebviewView | undefined;
  private git: Git | undefined;
  private refs: Ref[] = [];
  private changes: WorkingChange[] = [];
  private comparison: BranchComparison | undefined;
  private selectedRef: string | undefined;
  private seq = 0;
  private selectionSeq = 0;

  constructor(private readonly extensionUri: vscode.Uri) {}

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, "media")],
    };
    view.webview.html = this.html(view.webview);
    view.webview.onDidReceiveMessage((message) => void this.handle(message));
    view.onDidChangeVisibility(() => {
      if (view.visible) void this.refresh();
    });
  }

  async refresh(preferredRoot?: string): Promise<void> {
    if (!this.view) return;
    const seq = ++this.seq;
    ++this.selectionSeq;
    const repositories = await this.repositories();
    if (seq !== this.seq) return;
    if (repositories.length === 0) {
      this.git = undefined;
      this.view.badge = undefined;
      void this.view.webview.postMessage({ type: "data", repositories: [] });
      return;
    }

    const root = repositories.some((repo) => repo.root === preferredRoot)
      ? preferredRoot
      : repositories.some((repo) => repo.root === this.git?.root)
        ? this.git?.root
        : repositories[0].root;
    if (!root) return;
    this.git = new Git(root);
    const [head, refs, changes, sync, remotes] = await Promise.all([
      this.git.head(),
      this.git.refs(),
      this.git.workingChanges(),
      this.git.syncStatus(),
      this.git.remotes(),
    ]);
    if (seq !== this.seq) return;
    this.refs = refs;
    this.changes = changes;
    this.view.badge = changes.length
      ? {
          value: changes.length,
          tooltip: `${changes.length} ${changes.length === 1 ? "cambio pendiente" : "cambios pendientes"} de commit`,
        }
      : undefined;
    this.comparison = undefined;
    this.selectedRef = undefined;
    void this.view.webview.postMessage({
      type: "data",
      repositories,
      root,
      head,
      changes,
      sync,
      hasRemote: remotes.length > 0,
      branches: refs
        .filter((ref) => ref.type === "head" || ref.type === "remote")
        .sort(
          (left, right) =>
            Number(right.name === head.branch) -
              Number(left.name === head.branch) ||
            left.name.localeCompare(right.name),
        ),
    });
  }

  private async handle(message: {
    type?: unknown;
    [key: string]: unknown;
  }): Promise<void> {
    try {
      switch (message.type) {
        case "ready":
        case "refresh":
          return await this.refresh();
        case "repository":
          return await this.refresh(
            typeof message.root === "string" ? message.root : undefined,
          );
        case "openGraph":
          if (this.git) GraphPanel.show(this.extensionUri, this.git);
          return;
        case "openFolder":
          await vscode.commands.executeCommand(
            "workbench.action.files.openFolder",
          );
          return;
        case "selectBranch":
          return await this.selectBranch(message.name);
        case "switchBranch":
          return await this.switchBranch(message.name);
        case "createBranch":
          return await this.createBranch(message.name);
        case "commit":
          return await this.commit(message.message, message.push === true);
        case "push":
          return await this.push();
        case "pull":
          return await this.remoteOperation("Pull", ["pull"]);
        case "fetch":
          return await this.remoteOperation("Fetch", [
            "fetch",
            "--all",
            "--prune",
          ]);
        case "openWorkingFile":
          return await this.openWorkingFile(message.index);
        case "openBranchFile":
          return await this.openBranchFile(message.index);
      }
    } catch (error) {
      vscode.window.showErrorMessage(
        `Ovi Git: ${error instanceof Error ? error.message : String(error)}`,
      );
      void this.view?.webview.postMessage({ type: "idle" });
    }
  }

  private async selectBranch(name: unknown): Promise<void> {
    const ref =
      typeof name === "string"
        ? this.refs.find((item) => item.name === name && item.type !== "tag")
        : undefined;
    if (!this.git || !ref) throw new Error("La rama ya no está disponible.");
    const git = this.git;
    const seq = ++this.selectionSeq;
    const comparison = await git.branchComparison(ref.name);
    if (seq !== this.selectionSeq || git !== this.git) return;
    this.selectedRef = ref.name;
    this.comparison = comparison;
    void this.view?.webview.postMessage({
      type: "branchDetail",
      name: ref.name,
      files: this.comparison.files,
    });
  }

  private async switchBranch(name: unknown): Promise<void> {
    const ref =
      typeof name === "string"
        ? this.refs.find((item) => item.name === name && item.type === "head")
        : undefined;
    if (!this.git || !ref)
      throw new Error("Solo puedes cambiar directamente a una rama local.");
    await this.git.run(["switch", ref.name]);
    await this.afterMutation();
  }

  private async createBranch(name: unknown): Promise<void> {
    const value = typeof name === "string" ? name.trim() : "";
    if (!this.git || !(await this.git.isValidRefName("branch", value)))
      throw new Error("Escribe un nombre de rama válido.");
    await this.git.run(["switch", "-c", value]);
    await this.afterMutation("createBranch");
  }

  private async commit(message: unknown, push: boolean): Promise<void> {
    if (!this.git || this.changes.length === 0)
      throw new Error("No hay cambios para confirmar.");
    await this.git.commitAll(typeof message === "string" ? message : "");
    void this.view?.webview.postMessage({
      type: "mutationDone",
      operation: "commit",
    });
    if (push) return await this.push();
    await this.afterMutation();
  }

  private async push(): Promise<void> {
    if (!this.git) return;
    const [head, sync, remotes] = await Promise.all([
      this.git.head(),
      this.git.syncStatus(),
      this.git.remotes(),
    ]);
    if (!head.branch)
      throw new Error("No puedes hacer push con HEAD separado.");
    if (sync.upstream) return await this.remoteOperation("Push", ["push"]);
    if (remotes.length === 0)
      throw new Error("El repositorio no tiene ningún remoto configurado.");
    const remote = remotes.includes("origin")
      ? "origin"
      : remotes.length === 1
        ? remotes[0]
        : await vscode.window.showQuickPick(remotes, {
            placeHolder: `Remoto donde publicar ${head.branch}`,
          });
    if (!remote) return await this.afterMutation();
    await this.remoteOperation("Publicar rama", [
      "push",
      "-u",
      remote,
      head.branch,
    ]);
  }

  private async remoteOperation(title: string, args: string[]): Promise<void> {
    const git = this.git;
    if (!git) return;
    try {
      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: `Ovi Git: ${title}...`,
        },
        () => git.run(args),
      );
    } finally {
      await this.afterMutation();
    }
  }

  private async afterMutation(
    operation?: "createBranch" | "commit",
  ): Promise<void> {
    await vscode.commands.executeCommand("git.refresh");
    await this.refresh();
    if (operation)
      void this.view?.webview.postMessage({ type: "mutationDone", operation });
  }

  private async openWorkingFile(index: unknown): Promise<void> {
    const file = typeof index === "number" ? this.changes[index] : undefined;
    const head = this.git ? await this.git.head() : undefined;
    if (!this.git || !file || !head) return;
    const added = file.indexStatus === "?" || file.indexStatus === "A";
    const deleted = file.indexStatus === "D" || file.worktreeStatus === "D";
    const left = revisionUri(
      this.git.root,
      added || !head.hash ? "" : head.hash,
      file.oldPath ?? file.path,
    );
    const right = deleted
      ? revisionUri(this.git.root, "", file.path)
      : vscode.Uri.file(path.join(this.git.root, file.path));
    await vscode.commands.executeCommand(
      "vscode.diff",
      left,
      right,
      `${path.basename(file.path)} (HEAD ↔ cambios locales)`,
      { preview: true },
    );
  }

  private async openBranchFile(index: unknown): Promise<void> {
    const file =
      typeof index === "number" ? this.comparison?.files[index] : undefined;
    if (!this.git || !file || !this.comparison || !this.selectedRef) return;
    const left = revisionUri(
      this.git.root,
      file.status === "A" ? "" : this.comparison.base,
      file.oldPath ?? file.path,
    );
    const right = revisionUri(
      this.git.root,
      file.status === "D" ? "" : this.comparison.target,
      file.path,
    );
    await vscode.commands.executeCommand(
      "vscode.diff",
      left,
      right,
      `${path.basename(file.path)} (base ↔ ${this.selectedRef})`,
      { preview: true },
    );
  }

  private async repositories(): Promise<RepositoryItem[]> {
    const folders = vscode.workspace.workspaceFolders ?? [];
    const found = await Promise.all(
      folders.map((folder) => Git.findRoot(folder.uri.fsPath)),
    );
    return [...new Set(found.filter((root): root is string => !!root))].map(
      (root) => ({ root, name: path.basename(root) }),
    );
  }

  private html(webview: vscode.Webview): string {
    const resource = (file: string) =>
      webview.asWebviewUri(
        vscode.Uri.joinPath(this.extensionUri, "media", file),
      );
    const nonce = crypto.randomBytes(16).toString("base64");
    return `<!DOCTYPE html>
<html lang="es">
<head>
	<meta charset="UTF-8">
	<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
	<meta name="viewport" content="width=device-width, initial-scale=1.0">
	<link rel="stylesheet" href="${resource("workspace.css")}">
</head>
<body>
	<div id="empty" hidden>
		<strong>No hay un repositorio Git abierto</strong>
		<button id="openFolder">Abrir carpeta</button>
	</div>
	<main id="workspace" hidden>
		<header>
			<select id="repository" aria-label="Repositorio"></select>
			<button id="openGraph" class="icon" title="Abrir gráfico" aria-label="Abrir gráfico">⑂</button>
			<button id="refresh" class="icon" title="Actualizar" aria-label="Actualizar">↻</button>
		</header>
		<section class="head">
			<div class="eyebrow">Rama actual</div>
			<div class="head-row"><strong id="currentBranch"></strong><button id="toggleCreate">Nueva rama</button></div>
			<div id="syncInfo" class="sync-info"></div>
			<div id="syncActions" class="sync-actions">
				<button id="fetch" title="Descargar referencias de todos los remotos">Fetch</button>
				<button id="pull" title="Traer e integrar cambios del remoto">Pull</button>
				<button id="push" title="Enviar commits al remoto">Push</button>
			</div>
			<form id="createForm" hidden><input id="branchName" autocomplete="off" placeholder="feature/nombre"><button>Crear y cambiar</button></form>
		</section>
		<section>
			<div class="section-title"><strong>Cambios</strong><span id="changeCount"></span></div>
			<div id="changes" class="file-list"></div>
			<div id="clean" class="muted">El directorio de trabajo está limpio.</div>
			<form id="commitForm">
				<textarea id="commitMessage" rows="2" placeholder="Mensaje del commit" aria-label="Mensaje del commit"></textarea>
				<div class="commit-actions">
					<button id="commitButton" class="primary">Confirmar todos los cambios</button>
					<button id="commitPushButton" type="button" title="Confirmar todos los cambios y hacer push">Confirmar y push</button>
				</div>
			</form>
		</section>
		<section>
			<div class="section-title"><strong>Ramas</strong><span id="branchCount"></span></div>
			<div id="branches" class="branch-list"></div>
		</section>
		<section id="branchDetail" hidden>
			<div class="section-title"><strong id="branchTitle"></strong><span id="branchFileCount"></span></div>
			<div id="branchFiles" class="file-list"></div>
			<div id="branchClean" class="muted">Esta rama coincide con la rama actual.</div>
		</section>
	</main>
	<script nonce="${nonce}" src="${resource("workspace.js")}"></script>
</body>
</html>`;
  }
}
