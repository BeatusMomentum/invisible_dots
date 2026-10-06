"use client";
// Derived from AI Elements (Vercel) packages/elements/src/conversation.tsx at 6a9d5b1, Apache-2.0; changed: the `ai` message types and the download button are removed; imports are relative; the scroll button is named for assistive technology; the content is centered at the chat's reading width; the empty state shows its children below its words, not instead of them.

import { ArrowDownIcon } from "lucide-react";
import type { ComponentProps } from "react";
import { useCallback } from "react";
import { StickToBottom, useStickToBottomContext } from "use-stick-to-bottom";
import { cn } from "../../lib/utils";
import { Button } from "../ui/button";

export type ConversationProps = ComponentProps<typeof StickToBottom>;

/** The scrolling thread: it stays at the newest message while the person has not scrolled away. */
export const Conversation = ({ className, ...props }: ConversationProps) => (
  <StickToBottom className={cn("relative flex-1 overflow-y-hidden", className)} initial="smooth" resize="smooth" role="log" {...props} />
);

export type ConversationContentProps = ComponentProps<typeof StickToBottom.Content>;

export const ConversationContent = ({ className, ...props }: ConversationContentProps) => (
  <StickToBottom.Content className={cn("mx-auto flex w-full max-w-[760px] flex-col gap-6 p-4", className)} {...props} />
);

export type ConversationEmptyStateProps = ComponentProps<"div"> & {
  title?: string;
  description?: string;
  icon?: React.ReactNode;
};

export const ConversationEmptyState = ({ className, title = "No messages yet", description, icon, children, ...props }: ConversationEmptyStateProps) => (
  <div className={cn("flex size-full flex-col items-center justify-center gap-3 p-8 text-center", className)} {...props}>
    {icon && <div className="text-muted-foreground">{icon}</div>}
    <div className="space-y-1">
      <h2 className="text-sm font-medium">{title}</h2>
      {description && <p className="max-w-prose text-sm text-muted-foreground">{description}</p>}
    </div>
    {children}
  </div>
);

export type ConversationScrollButtonProps = ComponentProps<typeof Button>;

/** Shown only while the thread is scrolled up from its end. */
export const ConversationScrollButton = ({ className, ...props }: ConversationScrollButtonProps) => {
  const { isAtBottom, scrollToBottom } = useStickToBottomContext();
  const handleScrollToBottom = useCallback(() => {
    scrollToBottom();
  }, [scrollToBottom]);

  return (
    !isAtBottom && (
      <Button
        className={cn("absolute bottom-4 left-[50%] translate-x-[-50%] rounded-full", className)}
        onClick={handleScrollToBottom}
        size="icon"
        type="button"
        variant="outline"
        aria-label="Scroll to the latest message"
        {...props}
      >
        <ArrowDownIcon className="size-4" />
      </Button>
    )
  );
};
