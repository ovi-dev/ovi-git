import * as crypto from 'crypto';
import * as path from 'path';
import * as vscode from 'vscode';
import { revisionUri } from './contentProvider';
import { Commit, CommitDetail, Git, HASH_RE, Ref, Stash } from './git';
import { computeLayout } from './graph';

const PAGE_SIZE = 300;
const STASH_RE = /^stash@\{\d+\}$/;

interface Action<T extends string> extends vscode.QuickPickItem {
	id: T;
}

export class GraphPanel {
	private static readonly panels = new Map<string, GraphPanel>();

	private limit = PAGE_SIZE;
	private seq = 0;
	private commits = new Map<string, Commit>();
	private refs: Ref[] = [];
	private stashes: Stash[] = [];
	private head: { branch: string | null; hash: string | null } = { branch: null, hash: null };
	private detail: CommitDetail | undefined;
	private readonly disposables: vscode.Disposable[] = [];

	static show(extensionUri: vscode.Uri, git: Git): void {
		const existing = GraphPanel.panels.get(git.root);
		if (existing) {
			existing.panel.reveal();
			return;
		}
		const panel = vscode.window.createWebviewPanel('oviGit.graph', `Ovi Git: ${path.basename(git.root)}`, vscode.ViewColumn.One, {
			enableScripts: true,
			retainContextWhenHidden: true,
			localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'media')],
		});
		GraphPanel.panels.set(git.root, new GraphPanel(panel, extensionUri, git));
	}

	private constructor(private readonly panel: vscode.WebviewPanel, extensionUri: vscode.Uri, private readonly git: Git) {
		panel.iconPath = new vscode.ThemeIcon('git-merge');
		panel.webview.html = this.html(extensionUri);
		this.disposables.push(
			panel.onDidDispose(() => this.dispose()),
			panel.webview.onDidReceiveMessage(msg => this.handle(msg)),
			panel.onDidChangeViewState(e => {
				if (e.webviewPanel.visible) void this.handle({ type: 'refresh' });
			}),
		);
	}

	private dispose(): void {
		GraphPanel.panels.delete(this.git.root);
		this.disposables.forEach(d => d.dispose());
	}

	private async handle(msg: { type?: unknown; [key: string]: unknown }): Promise<void> {
		try {
			switch (msg.type) {
				case 'ready':
				case 'refresh':
					return await this.refresh();
				case 'loadMore':
					this.limit += PAGE_SIZE;
					return await this.refresh();
				case 'select':
					return await this.select(this.commit(msg.hash));
				case 'openFile':
					return await this.openFile(msg.hash, msg.index);
				case 'commitMenu':
					return await this.commitMenu(this.commit(msg.hash));
				case 'refMenu':
					return await this.refMenu(this.ref(msg.kind, msg.name));
				case 'stashMenu':
					return await this.stashMenu(typeof msg.selector === 'string' ? msg.selector : undefined);
				case 'uncommittedMenu':
					return await this.uncommittedMenu();
			}
		} catch (e) {
			vscode.window.showErrorMessage(`Ovi Git: ${e instanceof Error ? e.message : String(e)}`);
		}
	}

	private async refresh(): Promise<void> {
		const seq = ++this.seq;
		const [{ commits, hasMore }, refs, head, stashes, uncommitted] = await Promise.all([
			this.git.log(this.limit), this.git.refs(), this.git.head(), this.git.stashes(), this.git.uncommittedCount(),
		]);
		if (seq !== this.seq) return;
		this.commits = new Map(commits.map(c => [c.hash, c]));
		this.refs = refs;
		this.head = head;
		this.stashes = stashes;
		void this.panel.webview.postMessage({
			type: 'data', commits, refs, head, stashes, uncommitted, hasMore, layout: computeLayout(commits),
		});
	}

	private commit(hash: unknown): Commit {
		const commit = typeof hash === 'string' && HASH_RE.test(hash) ? this.commits.get(hash) : undefined;
		if (!commit) throw new Error('El commit ya no está cargado. Actualiza el gráfico.');
		return commit;
	}

	private ref(kind: unknown, name: unknown): Ref {
		const ref = this.refs.find(r => r.type === kind && r.name === name);
		if (!ref || ref.name.startsWith('-')) throw new Error('La referencia ya no existe. Actualiza el gráfico.');
		return ref;
	}

	private async select(commit: Commit): Promise<void> {
		this.detail = await this.git.commitDetail(commit.hash);
		void this.panel.webview.postMessage({ type: 'detail', detail: this.detail });
	}

	private async openFile(hash: unknown, index: unknown): Promise<void> {
		const detail = this.detail;
		const file = detail && detail.hash === hash && typeof index === 'number' ? detail.files[index] : undefined;
		if (!detail || !file) return;

		const parent = detail.parents[0];
		const left = revisionUri(this.git.root, file.status === 'A' || !parent ? '' : parent, file.oldPath ?? file.path);
		const right = revisionUri(this.git.root, file.status === 'D' ? '' : detail.hash, file.path);
		const title = `${path.basename(file.path)} (${parent ? parent.slice(0, 7) : 'vacío'} ↔ ${detail.hash.slice(0, 7)})`;
		await vscode.commands.executeCommand('vscode.diff', left, right, title, { preview: true });
	}

	private async commitMenu(commit: Commit): Promise<void> {
		const short = commit.hash.slice(0, 7);
		const mergeArgs = commit.parents.length > 1 ? ['-m', '1'] : [];
		const action = await this.choose(`Commit ${short}: ${commit.subject}`, [
			{ id: 'branch', label: '$(git-branch) Crear rama aquí…' },
			{ id: 'tag', label: '$(tag) Crear etiqueta aquí…' },
			{ id: 'checkout', label: '$(debug-step-over) Checkout (HEAD separado)' },
			{ id: 'cherryPick', label: '$(git-pull-request-go-to-changes) Cherry-pick en la rama actual' },
			{ id: 'revert', label: '$(discard) Revertir commit' },
			{ id: 'reset', label: '$(history) Reset de la rama actual a este commit…' },
			{ id: 'copy', label: '$(copy) Copiar hash' },
		]);

		switch (action) {
			case 'branch': {
				const name = await this.askRefName('branch', 'Nombre de la nueva rama');
				if (name) await this.run(['branch', name, commit.hash]);
				break;
			}
			case 'tag': {
				const name = await this.askRefName('tag', 'Nombre de la etiqueta');
				if (!name) break;
				const message = await vscode.window.showInputBox({ prompt: 'Mensaje (vacío = etiqueta ligera)' });
				if (message === undefined) break;
				await this.run(message ? ['tag', '-a', name, '-m', message, commit.hash] : ['tag', name, commit.hash]);
				break;
			}
			case 'checkout':
				await this.run(['switch', '--detach', commit.hash]);
				break;
			case 'cherryPick':
				await this.run(['cherry-pick', ...mergeArgs, commit.hash]);
				break;
			case 'revert':
				if (await this.confirm(`¿Crear un commit que revierta ${short}?`, 'Revertir')) {
					await this.run(['revert', '--no-edit', ...mergeArgs, commit.hash]);
				}
				break;
			case 'reset': {
				const mode = await this.choose(`Reset a ${short}`, [
					{ id: 'soft', label: 'Soft', detail: 'Conserva los cambios en el índice' },
					{ id: 'mixed', label: 'Mixed', detail: 'Conserva los cambios en el directorio de trabajo' },
					{ id: 'hard', label: 'Hard', detail: 'Descarta todos los cambios sin confirmar' },
				]);
				if (!mode) break;
				if (mode === 'hard' && !await this.confirm(`Se perderán los cambios sin confirmar. ¿Hacer reset --hard a ${short}?`, 'Reset')) break;
				await this.run(['reset', `--${mode}`, commit.hash]);
				break;
			}
			case 'copy':
				await vscode.env.clipboard.writeText(commit.hash);
				break;
		}
	}

	private async refMenu(ref: Ref): Promise<void> {
		if (ref.type === 'tag') {
			const action = await this.choose(`Etiqueta ${ref.name}`, [
				{ id: 'delete', label: '$(trash) Eliminar etiqueta' },
				{ id: 'copy', label: '$(copy) Copiar nombre' },
			]);
			if (action === 'delete' && await this.confirm(`¿Eliminar la etiqueta local ${ref.name}?`, 'Eliminar')) {
				await this.run(['tag', '-d', ref.name]);
			} else if (action === 'copy') {
				await vscode.env.clipboard.writeText(ref.name);
			}
			return;
		}

		const isCurrent = ref.type === 'head' && ref.name === this.head.branch;
		const items: Action<string>[] = [];
		if (!isCurrent) items.push({ id: 'checkout', label: '$(check) Checkout' });
		if (!isCurrent) items.push({ id: 'merge', label: `$(git-merge) Fusionar en ${this.head.branch ?? 'HEAD'}` });
		items.push({ id: 'branch', label: '$(git-branch) Crear rama desde aquí…' });
		if (ref.type === 'head' && !isCurrent) items.push({ id: 'delete', label: '$(trash) Eliminar rama' });
		if (ref.type === 'remote') items.push({ id: 'deleteRemote', label: '$(trash) Eliminar rama remota' });
		items.push({ id: 'copy', label: '$(copy) Copiar nombre' });

		switch (await this.choose(`Rama ${ref.name}`, items)) {
			case 'checkout':
				if (ref.type === 'head') {
					await this.run(['switch', ref.name]);
				} else {
					const local = await this.askRefName('branch', 'Nombre de la rama local', ref.name.slice(ref.name.indexOf('/') + 1));
					if (local) await this.run(['switch', '-c', local, '--track', ref.name]);
				}
				break;
			case 'merge':
				await this.run(['merge', '--no-edit', ref.name]);
				break;
			case 'branch': {
				const name = await this.askRefName('branch', 'Nombre de la nueva rama');
				if (name) await this.run(['branch', name, ref.name]);
				break;
			}
			case 'delete':
				await this.deleteBranch(ref.name);
				break;
			case 'deleteRemote': {
				const slash = ref.name.indexOf('/');
				const remote = ref.name.slice(0, slash);
				const branch = ref.name.slice(slash + 1);
				if (await this.confirm(`¿Eliminar la rama ${branch} del remoto ${remote}?`, 'Eliminar')) {
					await this.run(['push', remote, '--delete', branch]);
				}
				break;
			}
			case 'copy':
				await vscode.env.clipboard.writeText(ref.name);
				break;
		}
	}

	private async deleteBranch(name: string): Promise<void> {
		if (!await this.confirm(`¿Eliminar la rama ${name}?`, 'Eliminar')) return;
		try {
			await this.run(['branch', '-d', name]);
		} catch (e) {
			if (!(e instanceof Error) || !e.message.includes('not fully merged')) throw e;
			if (await this.confirm(`La rama ${name} tiene commits sin fusionar que se perderán. ¿Eliminarla igualmente?`, 'Forzar')) {
				await this.run(['branch', '-D', name]);
			}
		}
	}

	private async stashMenu(selector?: string): Promise<void> {
		let stash = this.stashes.find(s => s.selector === selector);
		if (!stash) {
			if (this.stashes.length === 0) {
				vscode.window.showInformationMessage('No hay stashes guardados.');
				return;
			}
			const pick = await vscode.window.showQuickPick(
				this.stashes.map(s => ({ label: s.selector, description: s.message, stash: s })),
				{ title: 'Stashes' },
			);
			stash = pick?.stash;
		}
		if (!stash || !STASH_RE.test(stash.selector)) return;

		const ref = stash.selector;
		switch (await this.choose(`${ref}: ${stash.message}`, [
			{ id: 'apply', label: '$(check) Aplicar' },
			{ id: 'pop', label: '$(arrow-up) Aplicar y eliminar (pop)' },
			{ id: 'branch', label: '$(git-branch) Crear rama desde el stash…' },
			{ id: 'drop', label: '$(trash) Eliminar' },
		])) {
			case 'apply':
				await this.run(['stash', 'apply', ref]);
				break;
			case 'pop':
				await this.run(['stash', 'pop', ref]);
				break;
			case 'branch': {
				const name = await this.askRefName('branch', 'Nombre de la nueva rama');
				if (name) await this.run(['stash', 'branch', name, ref]);
				break;
			}
			case 'drop':
				if (await this.confirm(`¿Eliminar ${ref}? No se podrá recuperar fácilmente.`, 'Eliminar')) {
					await this.run(['stash', 'drop', ref]);
				}
				break;
		}
	}

	private async uncommittedMenu(): Promise<void> {
		const action = await this.choose('Cambios sin confirmar', [
			{ id: 'stash', label: '$(archive) Guardar en stash (incluye archivos nuevos)' },
			{ id: 'stashTracked', label: '$(archive) Guardar en stash (solo archivos seguidos)' },
			{ id: 'scm', label: '$(source-control) Abrir Control de código fuente' },
		]);
		if (action === 'scm') {
			await vscode.commands.executeCommand('workbench.view.scm');
		} else if (action) {
			const message = await vscode.window.showInputBox({ prompt: 'Mensaje del stash (opcional)' });
			if (message === undefined) return;
			await this.run(['stash', 'push', ...(action === 'stash' ? ['-u'] : []), ...(message ? ['-m', message] : [])]);
		}
	}

	private async run(args: string[]): Promise<void> {
		try {
			await this.git.run(args);
		} finally {
			await this.refresh();
		}
	}

	private async choose<T extends string>(title: string, items: Action<T>[]): Promise<T | undefined> {
		return (await vscode.window.showQuickPick(items, { title, placeHolder: 'Elige una acción' }))?.id;
	}

	private async confirm(message: string, action: string): Promise<boolean> {
		return (await vscode.window.showWarningMessage(message, { modal: true }, action)) === action;
	}

	private askRefName(kind: 'branch' | 'tag', prompt: string, value?: string): Thenable<string | undefined> {
		return vscode.window.showInputBox({
			prompt,
			value,
			validateInput: async text => await this.git.isValidRefName(kind, text.trim()) ? undefined : 'Nombre no válido',
		}).then(name => name?.trim() || undefined);
	}

	private html(extensionUri: vscode.Uri): string {
		const webview = this.panel.webview;
		const media = (file: string) => webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', file));
		const nonce = crypto.randomBytes(16).toString('base64');
		return `<!DOCTYPE html>
<html lang="es">
<head>
	<meta charset="UTF-8">
	<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
	<meta name="viewport" content="width=device-width, initial-scale=1.0">
	<link rel="stylesheet" href="${media('style.css')}">
</head>
<body>
	<div id="toolbar">
		<button id="refresh" title="Actualizar">Actualizar</button>
		<button id="stashes" title="Ver stashes">Stashes</button>
		<input id="search" type="search" placeholder="Buscar por mensaje, autor, hash o rama…">
		<span id="matches"></span>
		<button id="prev" title="Anterior (Mayús+Intro)">↑</button>
		<button id="next" title="Siguiente (Intro)">↓</button>
	</div>
	<div id="uncommitted" hidden></div>
	<div id="list">
		<div id="rows"></div>
		<p id="empty" hidden>Este repositorio todavía no tiene commits.</p>
		<button id="more" hidden>Cargar más commits</button>
	</div>
	<div id="detail" hidden></div>
	<script nonce="${nonce}" src="${media('main.js')}"></script>
</body>
</html>`;
	}
}
