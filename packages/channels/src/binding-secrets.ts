import type { Database } from "@invisible-dots/database";
import { ChannelGoneError, type ChannelSecrets } from "./channel.js";

/** The secrets of one binding as its adapter reaches them (see `ChannelSecrets`), over the hub's database. */
export class BindingSecrets implements ChannelSecrets {
  constructor(
    private readonly db: Pick<Database, "secrets" | "transaction">,
    private readonly bindingId: string,
  ) {}

  get(scope: string, name: string): Promise<string | null> {
    return this.db.secrets.get(scope, name);
  }

  async putAll(scope: string, entries: Readonly<Record<string, string>>): Promise<void> {
    await this.db.transaction(async (tx) => {
      // The hold waits for a delete of the binding that is under way and then finds it gone; a delete that comes later waits for this commit.
      if (!(await tx.channels.holdBinding(this.bindingId))) throw new ChannelGoneError();
      for (const [name, value] of Object.entries(entries)) await tx.secrets.put(scope, name, value);
    });
  }
}
