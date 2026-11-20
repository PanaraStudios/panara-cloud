"use client";

import { useAction, useMutation } from "convex/react";
import type {
	FunctionArgs,
	FunctionReference,
	FunctionReturnType,
} from "convex/server";
import { useCallback, useState } from "react";
import { errorMessage } from "@/lib/auth/errors";

// The screens read `isPending`/`error` the way react-query mutations expose
// them; Convex mutations and actions are plain async functions, so track them here.
const usePending = <Args, Result>(call: (args: Args) => Promise<Result>) => {
	const [isPending, setIsPending] = useState(false);
	const [error, setError] = useState<Error | null>(null);
	const mutateAsync = useCallback(
		async (args: Args) => {
			setIsPending(true);
			setError(null);
			try {
				return await call(args);
			} catch (caught) {
				setError(new Error(errorMessage(caught)));
				throw caught;
			} finally {
				setIsPending(false);
			}
		},
		[call],
	);
	return { mutateAsync, isPending, error, isError: error !== null };
};

export const usePendingMutation = <
	Mutation extends FunctionReference<"mutation">,
>(
	mutation: Mutation,
) => {
	const call = useMutation(mutation) as unknown as (
		args: FunctionArgs<Mutation>,
	) => Promise<FunctionReturnType<Mutation>>;
	return usePending(call);
};

export const usePendingAction = <Action extends FunctionReference<"action">>(
	action: Action,
) => {
	const call = useAction(action) as unknown as (
		args: FunctionArgs<Action>,
	) => Promise<FunctionReturnType<Action>>;
	return usePending(call);
};
