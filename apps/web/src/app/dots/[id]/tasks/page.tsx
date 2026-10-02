import type { Metadata } from "next";
import { TasksTab } from "../../../../components/TasksTab";

export const metadata: Metadata = { title: "Tasks" };

export default function Page() {
  return <TasksTab />;
}
