import type { Metadata } from "next";
import { HostSettings } from "../../../components/settings/HostSettings";

export const metadata: Metadata = { title: "Settings" };

export default function SettingsPage() {
  return <HostSettings />;
}
