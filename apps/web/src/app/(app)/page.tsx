import type { Metadata } from "next";
import { HomePage } from "../../components/home/HomePage";

export const metadata: Metadata = { title: "Dots" };

export default function Home() {
  return <HomePage />;
}
