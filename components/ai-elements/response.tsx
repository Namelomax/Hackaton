"use client";

import { cn } from "@/lib/utils";
import { type ComponentProps, memo } from "react";
import { Streamdown } from "streamdown";
import remarkBreaks from "remark-breaks";
import remarkGfm from "remark-gfm";

type ResponseProps = ComponentProps<typeof Streamdown>;

export const Response = memo(
  ({ className, remarkPlugins, controls, ...props }: ResponseProps) => (
    <Streamdown
      remarkPlugins={remarkPlugins ?? [remarkGfm, remarkBreaks]}
      controls={controls}
      className={cn(
        "size-full leading-relaxed [&>*:first-child]:mt-0 [&>*:last-child]:mb-0",
        "[&_a]:font-semibold [&_a]:underline-offset-4 [&_a:hover]:underline",
        "[&_a]:text-primary",
        "group-[.is-user]:[&_a]:text-primary-foreground",
        // Списки
        "[&_ol]:list-decimal [&_ol]:ml-4",
        // Вложенные списки
        "[&_ol_ol]:list-decimal [&_ol_ol]:ml-4",
        // Таблицы (GFM)
        "[&_table]:w-full [&_table]:border-collapse [&_table]:my-2 [&_table]:text-sm",
        "[&_th]:border [&_th]:border-border [&_th]:px-3 [&_th]:py-2 [&_th]:bg-muted [&_th]:font-semibold [&_th]:text-left",
        "[&_td]:border [&_td]:border-border [&_td]:px-3 [&_td]:py-2",
        "[&_tr:nth-child(even)_td]:bg-muted/30",
        className
      )}
      {...props}
    />
  ),
    (prevProps, nextProps) =>
      prevProps.children === nextProps.children &&
      prevProps.controls === nextProps.controls &&
      prevProps.remarkPlugins === nextProps.remarkPlugins &&
      prevProps.className === nextProps.className
);

Response.displayName = "Response";
