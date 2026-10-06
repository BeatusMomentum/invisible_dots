import type { Metadata } from "next";
import { TaskDrawer } from "../../../../../../components/tasks/task-drawer";

export const metadata: Metadata = { title: "Task" };

export default async function Page({ params }: { params: Promise<{ taskId: string }> }) {
  const { taskId } = await params;
  return <TaskDrawer taskId={taskId} />;
}
