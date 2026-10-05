import type { Metadata } from "next";
import { ComputerTab } from "../../../../../components/ComputerTab";

export const metadata: Metadata = { title: "Computer" };

export default function Page() {
  return <ComputerTab />;
}
