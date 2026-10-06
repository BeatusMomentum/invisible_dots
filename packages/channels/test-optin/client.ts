/** The real Baileys module, loaded the way the adapter loads it: from the folder `npm run whatsapp:install` fills. */
import { fileURLToPath } from "node:url";
import { loadWhatsAppClient, whatsappClientDir } from "../src/whatsapp-baileys/client.js";

export type Baileys = typeof import("baileys");

/** The repository root. */
export const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));

/** The client folder of this repository. */
export const CLIENT_DIR = whatsappClientDir(REPO_ROOT);

/** The module, typed as the library's own: the adapter's view of it (`WhatsAppClient`) is proved to fit by `shape.ts`. */
export const baileys: Promise<Baileys> = loadWhatsAppClient(CLIENT_DIR) as unknown as Promise<Baileys>;
