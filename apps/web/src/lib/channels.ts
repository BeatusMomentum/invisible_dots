/** How a channel is named to the person. A `Record` over the contract's kinds, so a kind added there is a compile error here until it has a name. */
import type { ChannelKind, MessageOrigin } from "@invisible-dots/shared/browser";

export const CHANNEL_LABELS: Record<ChannelKind, string> = {
  telegram: "Telegram",
  whatsapp: "WhatsApp",
};

/** What to show beside a message that came through a channel; nothing for one sent from the web, the CLI or the SDK. */
export function viaChannel(origin: MessageOrigin | undefined): string | undefined {
  return origin ? `via ${CHANNEL_LABELS[origin.channel]}` : undefined;
}
