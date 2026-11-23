"use client";

import { useEffect, useState } from "react";

import { cn } from "@/lib/utils";

// opensend's auth-panel quote, with quotes about building and running software.
const QUOTES = [
	{
		text: "Simplicity is prerequisite for reliability.",
		author: "Edsger W. Dijkstra",
	},
	{ text: "Everything fails, all the time.", author: "Werner Vogels" },
	{ text: "You build it, you run it.", author: "Werner Vogels" },
	{ text: "Make it work, make it right, make it fast.", author: "Kent Beck" },
	{ text: "Real artists ship.", author: "Steve Jobs" },
	{ text: "Talk is cheap. Show me the code.", author: "Linus Torvalds" },
	{
		text: "Controlling complexity is the essence of computer programming.",
		author: "Brian Kernighan",
	},
	{
		text: "The best way to predict the future is to invent it.",
		author: "Alan Kay",
	},
	{
		text: "Programs must be written for people to read, and only incidentally for machines to execute.",
		author: "Harold Abelson",
	},
	{
		text: "Premature optimization is the root of all evil.",
		author: "Donald Knuth",
	},
] as const;

export function RandomQuote() {
	const [quote, setQuote] = useState<(typeof QUOTES)[number] | null>(null);

	// Pick on the first client frame so the quote animates in on each mount and
	// never mismatches the server-rendered HTML.
	useEffect(() => {
		const frame = requestAnimationFrame(() => {
			setQuote(QUOTES[Math.floor(Math.random() * QUOTES.length)] ?? null);
		});
		return () => cancelAnimationFrame(frame);
	}, []);

	return (
		<blockquote
			aria-hidden={quote === null}
			className={cn(
				"space-y-4 transition-all duration-700",
				quote ? "translate-y-0 opacity-100" : "translate-y-2 opacity-0",
			)}
		>
			<p className="font-serif text-3xl leading-snug text-balance italic [text-shadow:0_1px_2px_rgb(0_0_0/0.15)]">
				{quote?.text}
			</p>
			<footer className="text-sm text-white/60">{quote?.author}</footer>
		</blockquote>
	);
}
