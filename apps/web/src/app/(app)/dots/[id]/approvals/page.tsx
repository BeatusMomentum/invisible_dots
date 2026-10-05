import type { Metadata } from "next";
import { DotApprovalsTab } from "../../../../../components/DotApprovalsTab";

export const metadata: Metadata = { title: "Approvals" };

export default function Page() {
  return <DotApprovalsTab />;
}
