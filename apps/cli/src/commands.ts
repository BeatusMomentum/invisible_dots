/**
 * Command lines this command prints as the fix for something, kept in one
 * place so doctor, setup and the usage errors never tell the person two
 * different things. Each works as printed in a POSIX shell and in Windows
 * PowerShell alike: no redirection, nothing to quote.
 */

/** Stores the OpenRouter key: in a terminal it asks for it, one line; piped, it reads standard input. */
export const STORE_OPENROUTER_KEY = "invisible-dots secret openrouter";
