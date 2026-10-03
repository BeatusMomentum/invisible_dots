/**
 * Opens the store at argv[2], says "ready" on stdout and waits to be killed:
 * the owner process of the lock tests.
 */
import { DotStore } from "../../src/index.js";

const store = DotStore.open(process.argv[2]!);
store.setConfig("owner", process.pid);
process.stdout.write("ready\n");
setInterval(() => {}, 60_000);
