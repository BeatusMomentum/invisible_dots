import type { Metadata } from "next";
import { dotPageTitle } from "../../../../../../lib/dot-title";
import { TaskDrawer } from "../../../../../../components/tasks/task-drawer";

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }): Promise<Metadata> {
  return dotPageTitle((await params).id, "Task");
}

export default async function Page({ params }: { params: Promise<{ taskId: string }> }) {
  const { taskId } = await params;
  return <TaskDrawer taskId={taskId} />;
}
