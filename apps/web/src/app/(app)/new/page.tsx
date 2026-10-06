import type { Metadata } from "next";
import { NewDotPage } from "../../../components/new-dot/NewDotPage";

export const metadata: Metadata = { title: "Create a Dot" };

export default function New() {
  return <NewDotPage />;
}
