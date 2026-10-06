"use client";

import type { ChannelRecord } from "@invisible-dots/shared/browser";
import { AlertTriangleIcon } from "lucide-react";
import { CHANNEL_NOTES } from "../../lib/channels";
import { Alert, AlertDescription, AlertTitle } from "../ui/alert";
import { ChannelCard } from "./channel-card";
import { LinkedChannel } from "./linked-channel";
import { QrConnect } from "./qr-connect";

/** Whether the number is linked and running its course: a link in progress, or one that has to be done again, goes through the scan instead. */
function isLinked(record: ChannelRecord | undefined): record is ChannelRecord {
  return record !== undefined && (record.status === "connected" || (record.status === "error" && record.account !== null) || (!record.enabled && record.account !== null));
}

/**
 * WhatsApp (S12), offered only when the server was started with it. It is not an official client, so the card says what
 * that risks before anything is linked. Linking is a scan: the codes the host makes are shown here until the phone
 * reads one. A linked number then pairs people and shows what it does like any channel.
 */
export function WhatsAppCard({ dotId, record, onChanged }: { dotId: string; record: ChannelRecord | undefined; onChanged: () => void }) {
  return (
    <ChannelCard kind="whatsapp" record={record}>
      {isLinked(record) ? (
        <>
          {record.status === "error" && record.status_detail ? (
            <Alert variant="destructive">
              <AlertTriangleIcon />
              <AlertTitle>WhatsApp has a problem</AlertTitle>
              <AlertDescription>
                <p>{record.status_detail}</p>
              </AlertDescription>
            </Alert>
          ) : null}
          <LinkedChannel dotId={dotId} record={record} onChanged={onChanged} />
        </>
      ) : (
        <>
          <Alert>
            <AlertTriangleIcon />
            <AlertTitle>Read this before you link a number</AlertTitle>
            <AlertDescription>
              <p>{CHANNEL_NOTES.whatsapp}</p>
            </AlertDescription>
          </Alert>
          <QrConnect dotId={dotId} record={record} onChanged={onChanged} />
        </>
      )}
    </ChannelCard>
  );
}
