import type { Metadata } from "next";
import { DotsPage } from "../../components/DotsPage";

export const metadata: Metadata = { title: "Dots" };

export default function Home() {
  return (
    <div className="legacy">
      <DotsPage />
    </div>
  );
}
