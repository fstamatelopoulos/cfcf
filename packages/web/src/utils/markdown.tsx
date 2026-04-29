/**
 * Minimal Markdown renderer shared between the Help tab and the PA
 * session detail viewer.
 *
 * Handles the subset our cfcf-generated Markdown uses: headings,
 * paragraphs, lists (bulleted + ordered), fenced code, inline code,
 * bold/italic, blockquotes, horizontal rules, links. For docs more
 * elaborate than this, fall back to `cfcf help` in the terminal piped
 * through glow/bat.
 *
 * Originally inlined in `pages/Help.tsx` (5.8 PR2/PR3); extracted
 * here so PA's session detail viewer (5.14 v2) can reuse the same
 * renderer.
 */
import type React from "react";

/** Rewrite a `[text](url)` link's URL. Default: pass through unchanged. */
export type LinkRewriter = (url: string) => string;

const passthroughLink: LinkRewriter = (url) => url;

export interface MarkdownViewProps {
  content: string;
  rewriteLink?: LinkRewriter;
  className?: string;
  style?: React.CSSProperties;
}

export function MarkdownView({ content, rewriteLink = passthroughLink, className, style }: MarkdownViewProps) {
  return (
    <div className={className ?? "markdown-body"} style={style ?? mdRootStyle}>
      {renderMarkdown(content, rewriteLink)}
    </div>
  );
}

export function renderMarkdown(src: string, rewriteLink: LinkRewriter = passthroughLink): React.ReactNode[] {
  const lines = src.split("\n");
  const out: React.ReactNode[] = [];
  let key = 0;

  let i = 0;
  while (i < lines.length) {
    const line = lines[i];

    if (line.startsWith("```")) {
      const lang = line.slice(3).trim();
      const codeLines: string[] = [];
      i++;
      while (i < lines.length && !lines[i].startsWith("```")) {
        codeLines.push(lines[i]);
        i++;
      }
      i++;
      out.push(
        <pre key={key++} style={preStyle}>
          <code data-lang={lang}>{codeLines.join("\n")}</code>
        </pre>,
      );
      continue;
    }

    const h = line.match(/^(#{1,6})\s+(.+)$/);
    if (h) {
      const level = h[1].length;
      const text = h[2];
      const tag = `h${level}` as keyof React.JSX.IntrinsicElements;
      const Tag = tag;
      out.push(
        <Tag key={key++} style={headingStyle(level)}>
          {renderInline(text, rewriteLink)}
        </Tag>,
      );
      i++;
      continue;
    }

    if (line.startsWith("> ")) {
      const quoteLines: string[] = [];
      while (i < lines.length && lines[i].startsWith("> ")) {
        quoteLines.push(lines[i].slice(2));
        i++;
      }
      out.push(
        <blockquote key={key++} style={blockquoteStyle}>
          {renderInline(quoteLines.join(" "), rewriteLink)}
        </blockquote>,
      );
      continue;
    }

    if (line.match(/^[-*+]\s+/)) {
      const items: string[] = [];
      while (i < lines.length && lines[i].match(/^[-*+]\s+/)) {
        items.push(lines[i].replace(/^[-*+]\s+/, ""));
        i++;
      }
      out.push(
        <ul key={key++} style={listStyle}>
          {items.map((it, idx) => (
            <li key={idx}>{renderInline(it, rewriteLink)}</li>
          ))}
        </ul>,
      );
      continue;
    }

    if (line.match(/^\d+\.\s+/)) {
      const items: string[] = [];
      while (i < lines.length && lines[i].match(/^\d+\.\s+/)) {
        items.push(lines[i].replace(/^\d+\.\s+/, ""));
        i++;
      }
      out.push(
        <ol key={key++} style={listStyle}>
          {items.map((it, idx) => (
            <li key={idx}>{renderInline(it, rewriteLink)}</li>
          ))}
        </ol>,
      );
      continue;
    }

    if (line.match(/^---+\s*$/)) {
      out.push(<hr key={key++} style={hrStyle} />);
      i++;
      continue;
    }

    if (line.trim() === "") {
      i++;
      continue;
    }

    const paraLines: string[] = [];
    while (
      i < lines.length &&
      lines[i].trim() !== "" &&
      !lines[i].startsWith("```") &&
      !lines[i].match(/^#{1,6}\s+/) &&
      !lines[i].startsWith("> ") &&
      !lines[i].match(/^[-*+]\s+/) &&
      !lines[i].match(/^\d+\.\s+/) &&
      !lines[i].match(/^---+\s*$/)
    ) {
      paraLines.push(lines[i]);
      i++;
    }
    out.push(
      <p key={key++} style={paraStyle}>
        {renderInline(paraLines.join(" "), rewriteLink)}
      </p>,
    );
  }

  return out;
}

function renderInline(text: string, rewriteLink: LinkRewriter): React.ReactNode {
  const parts: React.ReactNode[] = [];
  let i = 0;
  let key = 0;
  let buf = "";

  const flushBuf = () => {
    if (buf) {
      parts.push(<span key={key++}>{buf}</span>);
      buf = "";
    }
  };

  while (i < text.length) {
    if (text[i] === "`") {
      const end = text.indexOf("`", i + 1);
      if (end > i) {
        flushBuf();
        parts.push(
          <code key={key++} style={inlineCodeStyle}>
            {text.slice(i + 1, end)}
          </code>,
        );
        i = end + 1;
        continue;
      }
    }
    if (text.startsWith("**", i)) {
      const end = text.indexOf("**", i + 2);
      if (end > i + 1) {
        flushBuf();
        parts.push(<strong key={key++}>{renderInline(text.slice(i + 2, end), rewriteLink)}</strong>);
        i = end + 2;
        continue;
      }
    }
    if (text[i] === "*") {
      const end = text.indexOf("*", i + 1);
      if (end > i) {
        flushBuf();
        parts.push(<em key={key++}>{renderInline(text.slice(i + 1, end), rewriteLink)}</em>);
        i = end + 1;
        continue;
      }
    }
    if (text[i] === "[") {
      const closeBracket = text.indexOf("]", i + 1);
      if (closeBracket > i && text[closeBracket + 1] === "(") {
        const closeParen = text.indexOf(")", closeBracket + 2);
        if (closeParen > closeBracket) {
          flushBuf();
          const linkText = text.slice(i + 1, closeBracket);
          const rawUrl = text.slice(closeBracket + 2, closeParen);
          const href = rewriteLink(rawUrl);
          parts.push(
            <a key={key++} href={href} target={href.startsWith("#") || href.startsWith("/") ? undefined : "_blank"} rel="noopener noreferrer">
              {linkText}
            </a>,
          );
          i = closeParen + 1;
          continue;
        }
      }
    }

    buf += text[i];
    i++;
  }
  flushBuf();
  return parts;
}

// ── Styles (theme-token-driven; same as the original Help renderer) ───

const mdRootStyle: React.CSSProperties = {
  color: "var(--color-text)",
  lineHeight: 1.55,
};

const preStyle: React.CSSProperties = {
  background: "var(--color-surface-alt)",
  color: "var(--color-text)",
  border: "1px solid var(--color-border)",
  borderRadius: "var(--radius)",
  padding: "12px",
  overflowX: "auto",
  fontSize: "0.85rem",
  fontFamily: "var(--font-mono)",
  margin: "12px 0",
};

const inlineCodeStyle: React.CSSProperties = {
  background: "color-mix(in srgb, var(--color-primary) 12%, transparent)",
  color: "var(--color-text)",
  padding: "1px 5px",
  borderRadius: "3px",
  fontSize: "0.88em",
  fontFamily: "var(--font-mono)",
};

const blockquoteStyle: React.CSSProperties = {
  borderLeft: "3px solid var(--color-primary)",
  margin: "12px 0",
  padding: "4px 12px",
  color: "var(--color-text-muted)",
  background: "color-mix(in srgb, var(--color-primary) 6%, transparent)",
};

const listStyle: React.CSSProperties = {
  paddingLeft: "1.4em",
  margin: "8px 0",
};

const paraStyle: React.CSSProperties = {
  margin: "8px 0",
};

const hrStyle: React.CSSProperties = {
  border: 0,
  borderTop: "1px solid var(--color-border)",
  margin: "16px 0",
};

function headingStyle(level: number): React.CSSProperties {
  const sizes = ["1.6rem", "1.35rem", "1.15rem", "1rem", "0.95rem", "0.9rem"];
  return {
    fontSize: sizes[level - 1] ?? "1rem",
    margin: level === 1 ? "8px 0 12px 0" : "16px 0 8px 0",
    fontWeight: level <= 2 ? 600 : 600,
    color: "var(--color-text)",
  };
}
