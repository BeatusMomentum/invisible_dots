import type { Metadata } from "next";
import { DotSettings } from "../../../../../components/dot-settings/DotSettings";

export const metadata: Metadata = { title: "Settings" };

export default function Page() {
  return <DotSettings />;
}
