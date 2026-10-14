"use client";

import { memo } from "react";
import Markdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";

import { cn } from "@/lib/utils/cn";

/**
 * Assistant replies as Markdown, rendered to React elements — never as raw
 * HTML: HTML in the text is dropped (`skipHtml`), unsafe link protocols such
 * as `javascript:` are removed by react-markdown, images are not loaded, and
 * links open in a new tab without referrer. Styles live in globals.css (.markdown).
 */
const COMPONENTS: Components = {
  a: ({ node: _node, ...props }) => (
    <a {...props} target="_blank" rel="noopener noreferrer nofollow" />
  ),
  table: ({ node: _node, ...props }) => (
    <div className="markdown-table">
      <table {...props} />
    </div>
  ),
};

const PLUGINS = [remarkGfm];
const DISALLOWED = ["img"];

export const MarkdownContent = memo(function MarkdownContent({
  text,
  streaming = false,
  className,
}: {
  text: string;
  /** Shows a blinking caret after the last block while the reply arrives. */
  streaming?: boolean;
  className?: string;
}) {
  return (
    <div className={cn("markdown", streaming && "markdown-streaming", className)}>
      <Markdown
        remarkPlugins={PLUGINS}
        components={COMPONENTS}
        disallowedElements={DISALLOWED}
        unwrapDisallowed
        skipHtml
      >
        {text}
      </Markdown>
    </div>
  );
});
