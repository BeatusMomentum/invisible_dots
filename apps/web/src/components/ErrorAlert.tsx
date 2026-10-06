import { AlertCircleIcon } from "lucide-react";
import { errorIssues } from "../lib/api";
import { Alert, AlertDescription, AlertTitle } from "./ui/alert";

/** A failed request, said in the new design: the message, and the field-level problems the API listed. */
export function ErrorAlert({ error, title }: { error: unknown; title: string }) {
  if (!error) return null;
  const message = error instanceof Error ? error.message : String(error);
  const issues = errorIssues(error);
  return (
    <Alert variant="destructive">
      <AlertCircleIcon />
      <AlertTitle>{title}</AlertTitle>
      <AlertDescription>
        <p>{message}</p>
        {issues.length > 0 ? (
          <ul className="list-disc pl-4">
            {issues.map((issue, i) => (
              <li key={i}>
                {issue.path ? <code>{issue.path}</code> : null}
                {issue.path ? ": " : null}
                {issue.message}
              </li>
            ))}
          </ul>
        ) : null}
      </AlertDescription>
    </Alert>
  );
}
