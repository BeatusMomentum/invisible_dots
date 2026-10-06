import type { Metadata } from "next";
import { SettingsTab } from "../../../../../components/SettingsTab";

export const metadata: Metadata = { title: "Settings" };

export default function Page() {
  return (
    <div className="legacy">
      <SettingsTab />
    </div>
  );
}
