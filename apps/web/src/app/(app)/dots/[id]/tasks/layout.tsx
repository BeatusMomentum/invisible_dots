import type { ReactNode } from "react";
import { TasksView } from "../../../../../components/tasks/TasksView";

export default function Layout({ children }: { children: ReactNode }) {
  return <TasksView>{children}</TasksView>;
}
