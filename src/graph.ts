import { Commit } from './git';

/** Coordinates are in lane units (x) and row units (y). */
export interface Segment {
	x1: number;
	y1: number;
	x2: number;
	y2: number;
	color: number;
}

export interface Layout {
	columns: number[];
	colors: number[];
	segments: Segment[];
	width: number;
}

export function computeLayout(commits: Commit[]): Layout {
	const lanes: (string | null)[] = [];
	const laneColor: number[] = [];
	const columns: number[] = [];
	const colors: number[] = [];
	const segments: Segment[] = [];
	let nextColor = 0;
	let width = 0;

	const openLane = (hash: string): number => {
		let i = lanes.indexOf(null);
		if (i === -1) i = lanes.length;
		lanes[i] = hash;
		laneColor[i] = nextColor++;
		return i;
	};

	commits.forEach((commit, row) => {
		const top = row;
		const mid = row + 0.5;
		const bottom = row + 1;

		let col = lanes.indexOf(commit.hash);
		if (col === -1) col = openLane(commit.hash);
		else segments.push({ x1: col, y1: top, x2: col, y2: mid, color: laneColor[col] });

		for (let i = 0; i < lanes.length; i++) {
			if (i === col || lanes[i] === null) continue;
			if (lanes[i] === commit.hash) {
				segments.push({ x1: i, y1: top, x2: col, y2: mid, color: laneColor[i] });
				lanes[i] = null;
			} else {
				segments.push({ x1: i, y1: top, x2: i, y2: bottom, color: laneColor[i] });
			}
		}

		columns.push(col);
		colors.push(laneColor[col]);

		if (commit.parents.length === 0) {
			lanes[col] = null;
		} else {
			lanes[col] = commit.parents[0];
			segments.push({ x1: col, y1: mid, x2: col, y2: bottom, color: laneColor[col] });
			for (const parent of commit.parents.slice(1)) {
				let lane = lanes.indexOf(parent);
				if (lane === -1) lane = openLane(parent);
				segments.push({ x1: col, y1: mid, x2: lane, y2: bottom, color: laneColor[lane] });
			}
		}

		width = Math.max(width, lanes.length, col + 1);
		while (lanes.length && lanes[lanes.length - 1] === null) lanes.pop();
	});

	return { columns, colors, segments, width };
}
