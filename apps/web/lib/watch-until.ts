// A subscription read until it has an answer. `settle` looks at each value:
// undefined means "not yet", anything else resolves, and a throw rejects
// (a job that failed). The throw must not leave through the subscription's
// own callback: there nobody catches it, the promise never settles, and
// whatever waits for it (a button's spinner) waits for good.

type Watch = {
	localQueryResult: () => unknown;
	onUpdate: (callback: () => void) => () => void;
};

export const watchUntil = <T, R>(
	watch: Watch,
	settle: (value: T) => R | undefined,
): Promise<R> =>
	new Promise<R>((resolve, reject) => {
		let unsubscribe: (() => void) | null = null;
		let done = false;
		const finish = (end: () => void) => {
			done = true;
			unsubscribe?.();
			end();
		};
		const check = () => {
			if (done) return;
			let result: R | undefined;
			try {
				const value = watch.localQueryResult() as T | undefined;
				if (value === undefined) return;
				result = settle(value);
			} catch (error) {
				finish(() => reject(error));
				return;
			}
			if (result === undefined) return;
			const settled = result;
			finish(() => resolve(settled));
		};
		unsubscribe = watch.onUpdate(check);
		check();
	});
