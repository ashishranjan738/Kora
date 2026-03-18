import { useMemo } from "react";
import { TypographyStylesProvider } from "@mantine/core";
import { marked } from "marked";
import DOMPurify from "dompurify";

interface MarkdownTextProps {
  children: string;
}

export function MarkdownText({ children }: MarkdownTextProps) {
  const html = useMemo(() => {
    return DOMPurify.sanitize(marked.parse(children) as string);
  }, [children]);

  return (
    <TypographyStylesProvider>
      <div dangerouslySetInnerHTML={{ __html: html }} />
    </TypographyStylesProvider>
  );
}
