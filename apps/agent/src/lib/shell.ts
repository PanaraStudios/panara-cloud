import { quote as shellQuote } from "shell-quote";

// Quote a single value for safe interpolation into a bash command.
export const quote = (value: string): string => shellQuote([value]);
