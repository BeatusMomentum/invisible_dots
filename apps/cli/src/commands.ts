/**
 * Command lines this command prints as the fix for something, kept in one
 * place so doctor, setup and the usage errors never tell the person two
 * different things. Each works as printed in a POSIX shell and in Windows
 * PowerShell alike: no redirection, nothing to quote. The ones the vm-manager's
 * doctor report names too (setup, the OpenRouter key) are in its errors.ts.
 */

/** Links a Dot to a Telegram bot: in a terminal it asks for the token, one line; piped, it reads standard input. */
export const addTelegramChannel = (dot: string): string => `invisible-dots channel add telegram --dot ${dot}`;
