import type { Metadata } from "next";
import { IdentitiesTab } from "../../../../../components/IdentitiesTab";

export const metadata: Metadata = { title: "Browser identities" };

export default function Page() {
  return <IdentitiesTab />;
}
