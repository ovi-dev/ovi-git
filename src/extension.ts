import * as path from "path";
import * as vscode from "vscode";
import { RevisionContentProvider, SCHEME } from "./contentProvider";
import { Git } from "./git";
import { GraphPanel } from "./panel";
import { WorkspaceViewProvider } from "./workspaceView";

export function activate(context: vscode.ExtensionContext): void {
  const workspaceView = new WorkspaceViewProvider(context.extensionUri);
  context.subscriptions.push(
    vscode.workspace.registerTextDocumentContentProvider(
      SCHEME,
      new RevisionContentProvider(),
    ),
    vscode.window.registerWebviewViewProvider(
      WorkspaceViewProvider.viewType,
      workspaceView,
      {
        webviewOptions: { retainContextWhenHidden: true },
      },
    ),
    vscode.commands.registerCommand("oviGit.open", async () => {
      const root = await pickRepository();
      if (root) GraphPanel.show(context.extensionUri, new Git(root));
    }),
    vscode.workspace.onDidSaveTextDocument(() => void workspaceView.refresh()),
    vscode.workspace.onDidCreateFiles(() => void workspaceView.refresh()),
    vscode.workspace.onDidDeleteFiles(() => void workspaceView.refresh()),
    vscode.workspace.onDidRenameFiles(() => void workspaceView.refresh()),
    vscode.window.onDidChangeWindowState((state) => {
      if (state.focused) void workspaceView.refresh();
    }),
  );
}

export function deactivate(): void {}

async function pickRepository(): Promise<string | undefined> {
  const folders = vscode.workspace.workspaceFolders ?? [];
  const found = await Promise.all(
    folders.map((f) => Git.findRoot(f.uri.fsPath)),
  );
  const roots = [...new Set(found.filter((r): r is string => !!r))];

  if (roots.length === 0) {
    vscode.window.showErrorMessage(
      "No se encontró ningún repositorio Git en el espacio de trabajo.",
    );
    return undefined;
  }
  if (roots.length === 1) return roots[0];

  const pick = await vscode.window.showQuickPick(
    roots.map((root) => ({
      label: path.basename(root),
      description: root,
      root,
    })),
    { placeHolder: "Elige un repositorio" },
  );
  return pick?.root;
}
