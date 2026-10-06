import type { Metadata } from "next";
import { ApprovalsList } from "../../../components/ApprovalsList";

export const metadata: Metadata = { title: "Approvals" };

export default function ApprovalsPage() {
  return (
    <div className="legacy">
      <div className="page-head">
        <h1>Pending approvals</h1>
      </div>
      <ApprovalsList />
    </div>
  );
}
