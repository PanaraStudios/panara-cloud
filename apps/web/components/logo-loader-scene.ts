// The loading mark: ten cubes that drop in and stack into a "P", then keep
// rebuilding themselves into a row of server towers and back, in the same
// isometric view as the preset avatars. `loaderFrame(ms)` returns the SVG for
// one moment.

type V3 = readonly [number, number, number];

export const LOADER_VIEWBOX = "-4.6 -5.6 9.2 10.4";

// Half the width of a cube on screen, and half the height of its top face.
const W = 1;
const H = 0.5774;

const DROP_MS = 420;
const DROP_GAP_MS = 60;
const HOLD_MS = 900;
const MOVE_MS = 600;
const MOVE_GAP_MS = 36;

// A figure from its rows, top row first: "#" is a cube. It stands in the
// x-z plane, so it reads on the cubes' left faces.
const figure = (...rows: string[]): V3[] =>
	rows
		.flatMap((row, index) =>
			[...row].flatMap((cell, x): V3[] =>
				cell === "#" ? [[x, 0, rows.length - 1 - index]] : [],
			),
		)
		.sort((a, b) => a[2] - b[2] || a[0] - b[0]);

const P = figure("###", "#.#", "###", "#..", "#..");
const SERVERS = figure("..#..", "#.#.#", "#.#.#", "#.#.#");

const project = ([x, y, z]: V3) =>
	[(x - y) * W, (x + y) * H - z * 2 * H] as const;

// Each figure is moved so its picture sits in the middle of the view.
const centred = (cubes: V3[]): V3[] => {
	const corners = cubes.flatMap(([x, y, z]) =>
		[0, 1].flatMap((dx) =>
			[0, 1].flatMap((dy) =>
				[0, 1].map((dz) => project([x + dx, y + dy, z + dz])),
			),
		),
	);
	const middle = (axis: 0 | 1) =>
		(Math.min(...corners.map((corner) => corner[axis])) +
			Math.max(...corners.map((corner) => corner[axis]))) /
		2;
	// A shift along x and z that moves the picture by (-middle x, -middle y).
	const dx = -middle(0) / W;
	const dz = (middle(1) + dx * H) / (2 * H);
	return cubes.map(([x, y, z]) => [x + dx, y, z + dz]);
};

const FIGURES = [P, SERVERS].map(centred);
const CUBES = P.length;
const INTRO_MS = DROP_MS + (CUBES - 1) * DROP_GAP_MS;
const STEP_MS = HOLD_MS + MOVE_MS + (CUBES - 1) * MOVE_GAP_MS;

/** A moment at which the finished "P" stands still. */
export const LOADER_STILL_MS = INTRO_MS + 1;

const clamp = (value: number) => Math.min(1, Math.max(0, value));
const easeOut = (t: number) => 1 - (1 - t) ** 3;
const easeInOut = (t: number) =>
	t < 0.5 ? 4 * t ** 3 : 1 - (-2 * t + 2) ** 3 / 2;
const n = (value: number) => value.toFixed(3);

type Cube = { at: V3; opacity: number };

function cubesAt(ms: number): Cube[] {
	const first = FIGURES[0] as V3[];
	if (ms < INTRO_MS) {
		return first.map((to, index) => {
			const t = clamp((ms - index * DROP_GAP_MS) / DROP_MS);
			return {
				at: [to[0], to[1], to[2] + 5 * (1 - easeOut(t))],
				opacity: clamp(t * 3),
			};
		});
	}
	const since = ms - INTRO_MS;
	const step = Math.floor(since / STEP_MS);
	const within = since - step * STEP_MS - HOLD_MS;
	const from = FIGURES[step % FIGURES.length] as V3[];
	const to = FIGURES[(step + 1) % FIGURES.length] as V3[];
	return from.map((start, index) => {
		const end = to[index] as V3;
		const t = easeInOut(clamp((within - index * MOVE_GAP_MS) / MOVE_MS));
		// Each cube hops over to its next place.
		const hop = Math.sin(t * Math.PI) * 0.9;
		return {
			at: [
				start[0] + (end[0] - start[0]) * t,
				start[1] + (end[1] - start[1]) * t,
				start[2] + (end[2] - start[2]) * t + hop,
			],
			opacity: 1,
		};
	});
}

const FACES: readonly (readonly [string, V3[]])[] = [
	[
		"var(--cube-top)",
		[
			[0, 0, 1],
			[1, 0, 1],
			[1, 1, 1],
			[0, 1, 1],
		],
	],
	[
		"var(--cube-left)",
		[
			[0, 1, 1],
			[1, 1, 1],
			[1, 1, 0],
			[0, 1, 0],
		],
	],
	[
		"var(--cube-right)",
		[
			[1, 0, 1],
			[1, 1, 1],
			[1, 1, 0],
			[1, 0, 0],
		],
	],
];

export function loaderFrame(ms: number): string {
	return cubesAt(Math.max(0, ms))
		.sort(
			(a, b) =>
				a.at[0] + a.at[1] + a.at[2] - (b.at[0] + b.at[1] + b.at[2]) ||
				a.at[2] - b.at[2],
		)
		.map(({ at, opacity }) => {
			const faces = FACES.map(([fill, corners]) => {
				const points = corners
					.map(([dx, dy, dz]) => {
						const [x, y] = project([at[0] + dx, at[1] + dy, at[2] + dz]);
						return `${n(x)},${n(y)}`;
					})
					.join(" ");
				// The hairline in the face's own colour closes the seams between faces.
				return `<polygon points="${points}" fill="${fill}" stroke="${fill}" stroke-width="0.03"/>`;
			}).join("");
			return `<g opacity="${n(opacity)}">${faces}</g>`;
		})
		.join("");
}
