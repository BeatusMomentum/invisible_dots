import type { Metadata } from "next";
import { DotsPage } from "../components/DotsPage";
import { EventStreamProvider } from "../components/events";

export const metadata: Metadata = { title: "Dots" };

export default function Home() {
  return (
    <EventStreamProvider>
      <DotsPage />
    </EventStreamProvider>
  );
}
