import type { Metadata } from "next";
import { ApprovalsList } from "../../../components/ApprovalsList";
import { EventStreamProvider, StreamIndicator } from "../../../components/events";

export const metadata: Metadata = { title: "Approvals" };

export default function ApprovalsPage() {
  return (
    <EventStreamProvider>
      <div className="page-head">
        <h1>Pending approvals</h1>
        <StreamIndicator />
      </div>
      <ApprovalsList />
    </EventStreamProvider>
  );
}
