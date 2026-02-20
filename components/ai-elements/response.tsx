"use client";

import { cn } from "@/lib/utils";
import { type ComponentProps, memo } from "react";
import { Streamdown } from "streamdown";

type ResponseProps = ComponentProps<typeof Streamdown>;

export const Response = memo(
  ({ className, ...props }: ResponseProps) => (
    <Streamdown
      className={cn(
        "size-full leading-relaxed [&>*:first-child]:mt-0 [&>*:last-child]:mb-0",
        "[&_a]:font-semibold [&_a]:underline-offset-4 [&_a:hover]:underline",
        "[&_a]:text-primary",
        "group-[.is-user]:[&_a]:text-primary-foreground",
        // Сбрасываем счетчик для каждого <ol> элемента, чтобы нумерация начиналась сначала
        "[&_ol]:list-decimal [&_ol]:ml-4",
        "[&_ol_ol]:list-decimal",
        className
      )}
      {...props}
    />
  ),
  (prevProps, nextProps) => prevProps.children === nextProps.children
);

Response.displayName = "Response";
