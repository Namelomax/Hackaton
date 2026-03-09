"use client";

import { cn } from "@/lib/utils";
import { type ComponentProps, memo } from "react";
import { Streamdown } from "streamdown";
import remarkBreaks from "remark-breaks";

type ResponseProps = ComponentProps<typeof Streamdown>;

export const Response = memo(
  ({ className, ...props }: ResponseProps) => (
    <Streamdown
      remarkPlugins={[remarkBreaks]}
      className={cn(
        "size-full leading-relaxed [&>*:first-child]:mt-0 [&>*:last-child]:mb-0",
        "[&_a]:font-semibold [&_a]:underline-offset-4 [&_a:hover]:underline",
        "[&_a]:text-primary",
        "group-[.is-user]:[&_a]:text-primary-foreground",
        // Списки
        "[&_ol]:list-decimal [&_ol]:ml-4",
        // Вложенные списки
        "[&_ol_ol]:list-decimal [&_ol_ol]:ml-4",
        className
      )}
      {...props}
    />
  ),
  (prevProps, nextProps) => prevProps.children === nextProps.children
);

Response.displayName = "Response";
