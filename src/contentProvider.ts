import * as vscode from 'vscode';
import { Git, HASH_RE } from './git';

export const SCHEME = 'ovi-git';

/** An empty `ref` produces an empty document (used for added or deleted files). */
export function revisionUri(root: string, ref: string, filePath: string): vscode.Uri {
	return vscode.Uri.from({ scheme: SCHEME, path: '/' + filePath, query: new URLSearchParams({ root, ref }).toString() });
}

export class RevisionContentProvider implements vscode.TextDocumentContentProvider {
	async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
		const query = new URLSearchParams(uri.query);
		const root = query.get('root');
		const ref = query.get('ref');
		if (!root || !ref || !HASH_RE.test(ref)) return '';
		try {
			return await new Git(root).run(['show', `${ref}:${uri.path.slice(1)}`]);
		} catch {
			return '';
		}
	}
}
