// @ts-check
(function () {
	// @ts-ignore provided by the VS Code webview host
	const vscode = acquireVsCodeApi();
	const ROW = 26;
	const LANE = 16;
	const PAD = 12;
	const SVG_NS = 'http://www.w3.org/2000/svg';
	const PALETTE = ['#3794ff', '#f9a03f', '#3ec7a8', '#e06cbc', '#c8c84c', '#f14c4c', '#a08cff', '#5fbf5f'];

	/** @type {any} */
	let state = null;
	/** @type {string | null} */
	let selected = null;
	/** @type {string[]} */
	let matches = [];
	let matchIndex = -1;

	const $ = (/** @type {string} */ id) => /** @type {HTMLElement} */ (document.getElementById(id));
	const color = (/** @type {number} */ i) => PALETTE[i % PALETTE.length];
	const laneX = (/** @type {number} */ lane) => PAD + lane * LANE;
	const formatDate = (/** @type {number} */ seconds) => new Date(seconds * 1000).toLocaleString();

	/**
	 * @param {string} tag
	 * @param {string} [className]
	 * @param {string} [text]
	 */
	function el(tag, className, text) {
		const node = document.createElement(tag);
		if (className) node.className = className;
		if (text !== undefined) node.textContent = text;
		return node;
	}

	/** @param {string} tag @param {Record<string, string | number>} attrs */
	function svgEl(tag, attrs) {
		const node = document.createElementNS(SVG_NS, tag);
		for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, String(value));
		return node;
	}

	function render() {
		const { commits, refs, head, uncommitted, hasMore, layout } = state;
		const rows = $('rows');
		rows.textContent = '';
		$('empty').hidden = commits.length > 0;
		$('more').hidden = !hasMore;

		const banner = $('uncommitted');
		banner.hidden = uncommitted === 0;
		banner.textContent = `● ${uncommitted} ${uncommitted === 1 ? 'cambio sin confirmar' : 'cambios sin confirmar'}`;

		/** @type {Map<string, any[]>} */
		const refsByHash = new Map();
		for (const ref of refs) {
			if (!refsByHash.has(ref.hash)) refsByHash.set(ref.hash, []);
			refsByHash.get(ref.hash)?.push(ref);
		}

		const graphWidth = PAD * 2 + Math.max(layout.width - 1, 0) * LANE;
		const svg = svgEl('svg', { class: 'graph', width: graphWidth, height: commits.length * ROW });
		for (const s of layout.segments) {
			const x1 = laneX(s.x1), y1 = s.y1 * ROW, x2 = laneX(s.x2), y2 = s.y2 * ROW;
			const midY = (y1 + y2) / 2;
			const d = x1 === x2 ? `M${x1},${y1}L${x2},${y2}` : `M${x1},${y1}C${x1},${midY} ${x2},${midY} ${x2},${y2}`;
			svg.appendChild(svgEl('path', { d, stroke: color(s.color), 'stroke-width': 2, fill: 'none' }));
		}
		commits.forEach((/** @type {any} */ c, /** @type {number} */ i) => {
			const isHead = c.hash === head.hash;
			svg.appendChild(svgEl('circle', {
				cx: laneX(layout.columns[i]), cy: (i + 0.5) * ROW, r: isHead ? 5 : 4,
				fill: isHead ? 'var(--vscode-editor-background)' : color(layout.colors[i]),
				stroke: color(layout.colors[i]), 'stroke-width': isHead ? 3 : 1,
			}));
		});
		rows.appendChild(svg);

		commits.forEach((/** @type {any} */ c) => {
			const row = el('div', 'row');
			row.dataset.hash = c.hash;
			if (c.hash === selected) row.classList.add('selected');

			const spacer = el('div', 'spacer');
			spacer.style.width = `${graphWidth}px`;
			row.appendChild(spacer);

			const message = el('div', 'message');
			for (const ref of refsByHash.get(c.hash) ?? []) {
				const badge = el('span', `badge ${ref.type}`, ref.name);
				if (ref.type === 'head' && ref.name === head.branch) badge.classList.add('current');
				badge.dataset.kind = ref.type;
				badge.dataset.name = ref.name;
				badge.title = 'Clic para ver acciones';
				message.appendChild(badge);
			}
			if (c.hash === head.hash && !head.branch) message.appendChild(el('span', 'badge detached', 'HEAD'));
			message.appendChild(el('span', 'subject', c.subject));
			row.appendChild(message);

			row.appendChild(el('div', 'author', c.author));
			row.appendChild(el('div', 'date', formatDate(c.date)));
			row.appendChild(el('div', 'hash', c.hash.slice(0, 7)));
			rows.appendChild(row);
		});

		search(false);
	}

	/** @param {any} d */
	function renderDetail(d) {
		const panel = $('detail');
		panel.textContent = '';
		panel.hidden = false;

		const header = el('div', 'detail-header');
		header.appendChild(el('h2', '', d.subject));
		const close = el('button', 'close', '×');
		close.title = 'Cerrar (Esc)';
		close.addEventListener('click', closeDetail);
		header.appendChild(close);
		panel.appendChild(header);

		const meta = el('dl', 'meta');
		const add = (/** @type {string} */ label, /** @type {string} */ value) => {
			meta.appendChild(el('dt', '', label));
			meta.appendChild(el('dd', '', value));
		};
		add('Commit', d.hash);
		add('Padres', d.parents.map((/** @type {string} */ p) => p.slice(0, 7)).join(', ') || '—');
		add('Autor', `${d.author} <${d.email}> · ${formatDate(d.date)}`);
		if (d.committer !== d.author || d.commitDate !== d.date) add('Confirmado por', `${d.committer} · ${formatDate(d.commitDate)}`);
		panel.appendChild(meta);

		if (d.body) panel.appendChild(el('pre', 'body', d.body));

		panel.appendChild(el('h3', '', `Archivos (${d.files.length})`));
		const list = el('ul', 'files');
		d.files.forEach((/** @type {any} */ f, /** @type {number} */ index) => {
			const item = el('li', `file status-${f.status}`);
			item.appendChild(el('span', 'status', f.status));
			item.appendChild(el('span', 'path', f.oldPath ? `${f.oldPath} → ${f.path}` : f.path));
			item.title = 'Abrir diff';
			item.addEventListener('click', () => vscode.postMessage({ type: 'openFile', hash: d.hash, index }));
			list.appendChild(item);
		});
		panel.appendChild(list);
	}

	function closeDetail() {
		$('detail').hidden = true;
		selected = null;
		document.querySelectorAll('.row.selected').forEach(r => r.classList.remove('selected'));
	}

	/** @param {boolean} scroll */
	function search(scroll) {
		const input = /** @type {HTMLInputElement} */ ($('search'));
		const query = input.value.trim().toLowerCase();
		const previous = matches[matchIndex];
		matches = [];
		if (query && state) {
			/** @type {Map<string, string>} */
			const refText = new Map();
			for (const ref of state.refs) refText.set(ref.hash, `${refText.get(ref.hash) ?? ''} ${ref.name}`);
			for (const c of state.commits) {
				const haystack = `${c.subject}\n${c.author}\n${c.email}\n${c.hash}\n${refText.get(c.hash) ?? ''}`.toLowerCase();
				if (haystack.includes(query)) matches.push(c.hash);
			}
		}
		matchIndex = matches.length ? Math.max(matches.indexOf(previous), 0) : -1;
		highlight(scroll);
	}

	/** @param {number} step */
	function move(step) {
		if (!matches.length) return;
		matchIndex = (matchIndex + step + matches.length) % matches.length;
		highlight(true);
	}

	/** @param {boolean} scroll */
	function highlight(scroll) {
		const set = new Set(matches);
		const current = matches[matchIndex];
		document.querySelectorAll('.row').forEach(node => {
			const row = /** @type {HTMLElement} */ (node);
			row.classList.toggle('match', set.has(row.dataset.hash ?? ''));
			row.classList.toggle('current-match', row.dataset.hash === current);
			if (scroll && row.dataset.hash === current) row.scrollIntoView({ block: 'center' });
		});
		const query = /** @type {HTMLInputElement} */ ($('search')).value.trim();
		$('matches').textContent = query ? (matches.length ? `${matchIndex + 1} de ${matches.length}` : 'Sin resultados') : '';
	}

	$('rows').addEventListener('click', e => {
		const target = /** @type {HTMLElement} */ (e.target);
		const badge = /** @type {HTMLElement | null} */ (target.closest('.badge[data-kind]'));
		if (badge) {
			vscode.postMessage({ type: 'refMenu', kind: badge.dataset.kind, name: badge.dataset.name });
			return;
		}
		const row = /** @type {HTMLElement | null} */ (target.closest('.row'));
		if (!row) return;
		selected = row.dataset.hash ?? null;
		document.querySelectorAll('.row.selected').forEach(r => r.classList.remove('selected'));
		row.classList.add('selected');
		vscode.postMessage({ type: 'select', hash: selected });
	});

	$('rows').addEventListener('contextmenu', e => {
		const target = /** @type {HTMLElement} */ (e.target);
		const badge = /** @type {HTMLElement | null} */ (target.closest('.badge[data-kind]'));
		const row = /** @type {HTMLElement | null} */ (target.closest('.row'));
		if (!badge && !row) return;
		e.preventDefault();
		if (badge) vscode.postMessage({ type: 'refMenu', kind: badge.dataset.kind, name: badge.dataset.name });
		else if (row) vscode.postMessage({ type: 'commitMenu', hash: row.dataset.hash });
	});

	$('uncommitted').addEventListener('click', () => vscode.postMessage({ type: 'uncommittedMenu' }));
	$('refresh').addEventListener('click', () => vscode.postMessage({ type: 'refresh' }));
	$('stashes').addEventListener('click', () => vscode.postMessage({ type: 'stashMenu' }));
	$('more').addEventListener('click', () => vscode.postMessage({ type: 'loadMore' }));
	$('prev').addEventListener('click', () => move(-1));
	$('next').addEventListener('click', () => move(1));
	$('search').addEventListener('input', () => search(true));
	$('search').addEventListener('keydown', e => {
		if (e.key === 'Enter') move(e.shiftKey ? -1 : 1);
	});

	document.addEventListener('keydown', e => {
		if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f') {
			e.preventDefault();
			/** @type {HTMLInputElement} */ ($('search')).select();
		} else if (e.key === 'Escape' && !$('detail').hidden) {
			closeDetail();
		}
	});

	window.addEventListener('message', event => {
		const msg = event.data;
		if (msg.type === 'data') {
			state = msg;
			render();
		} else if (msg.type === 'detail' && msg.detail.hash === selected) {
			renderDetail(msg.detail);
		}
	});

	vscode.postMessage({ type: 'ready' });
})();
