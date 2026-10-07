import type { ReactNode } from "react";
import { EventStreamProvider } from "../../components/events";
import { AttentionProvider } from "../../components/shell/attention";
import { AppShell } from "../../components/shell/AppShell";

/**
 * Everything behind the session: one live stream, what needs the person, and the frame with the rail. The login
 * page lives outside this group on purpose, because it has no session and so nothing here may call the API.
 */
export default function AppLayout({ children }: { children: ReactNode }) {
  return (
    <EventStreamProvider>
      <AttentionProvider>
        <AppShell>{children}</AppShell>
      </AttentionProvider>
    </EventStreamProvider>
  );
}
