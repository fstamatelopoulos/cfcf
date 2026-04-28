/**
 * Help tab -- renders the embedded user-manual and focused guides
 * served by the server's `/api/help/*` routes (which read from the
 * help-content bundle generated at build time from docs/guides/*.md).
 *
 * Two-pane layout:
 *   - Left: scrollable list of topics with title + slug
 *   - Right: rendered Markdown of the selected topic
 *
 * Markdown rendering is intentionally minimal — we don't ship a full
 * Markdown library to keep the bundle tiny. The simple renderer here
 * handles headings, paragraphs, lists, fenced code, inline code,
 * bold/em, and links. For ultra-rich rendering, users can pipe
 * `cfcf help <topic>` through `glow` or `bat -l md` in the terminal.
 *
 * Plan item 5.8 PR2/PR3.
 */

import { useEffect, useState } from "react";
import {
  fetchHelpTopics,
  fetchHelpTopic,
  type HelpTopicSummary,
  type HelpTopic,
} from "../api";
import { useRoute, navigateTo } from "../hooks/useRoute";

export function HelpPage() {
  const route = useRoute();
  const [topics, setTopics] = useState<HelpTopicSummary[] | null>(null);
  const [selected, setSelected] = useState<HelpTopic | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loadingContent, setLoadingContent] = useState(false);

  // Load topic list once.
  useEffect(() => {
    fetchHelpTopics()
      .then((data) => setTopics(data.topics))
      .catch((err) => setError(`Failed to load topics: ${err.message}`));
  }, []);

  // Load the selected topic. URL drives selection (#/help/<slug>);
  // default to "manual" if no slug present.
  const slug = route.helpTopic ?? "manual";
  useEffect(() => {
    setLoadingContent(true);
    setError(null);
    fetchHelpTopic(slug)
      .then((topic) => setSelected(topic))
      .catch((err) => setError(`Failed to load "${slug}": ${err.message}`))
      .finally(() => setLoadingContent(false));
  }, [slug]);

  return (
    <div className="help-page" style={pageStyle}>
      <aside style={asideStyle}>
        <h2 style={asideHeadingStyle}>Help topics</h2>
        {topics === null ? (
          <p>Loading…</p>
        ) : (
          <ul style={topicListStyle}>
            {topics.map((t) => (
              <li key={t.slug}>
                <button
                  type="button"
                  onClick={() => navigateTo(`/help/${encodeURIComponent(t.slug)}`)}
                  style={topicButtonStyle(t.slug === slug)}
                >
                  <strong>{t.title}</strong>
                  <span style={slugStyle}>{t.slug}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
        <p style={tipStyle}>
          The same content is available offline via <code>cfcf help &lt;topic&gt;</code>.
          Pipe through <code>glow</code> or <code>bat -l md</code> for richer terminal rendering.
        </p>
      </aside>

      <article style={articleStyle}>
        {error ? (
          <div style={errorStyle}>
            <p><strong>Error:</strong> {error}</p>
            <p>
              <button type="button" onClick={() => navigateTo("/help/manual")}>
                Try the manual
              </button>
            </p>
          </div>
        ) : loadingContent || !selected ? (
          <p>Loading topic…</p>
        ) : (
          <>
            <div style={metaStyle}>
              <span>
                Source: <code>{selected.source}</code>
              </span>
              {selected.aliases.length > 0 && (
                <span>aliases: {selected.aliases.join(", ")}</span>
              )}
            </div>
            <MarkdownView content={selected.content} />
          </>
        )}
      </article>
    </div>
  );
}

// ── Minimal Markdown renderer ───────────────────────────────────────────
// Handles the subset our docs use: headings, paragraphs, lists (bulleted +
// ordered), fenced code, inline code, bold/em, links, blockquotes, tables.
// For docs more elaborate than this, fall back to `cfcf help` in the
// terminal piped through glow/bat.

function MarkdownView({ content }: { content: string }) {
  return (
    <div className="markdown-body" style={mdRootStyle}>
      {renderMarkdown(content)}
    </div>
  );
}

function renderMarkdown(src: string): React.ReactNode[] {
  const lines = src.split("\n");
  const out: React.ReactNode[] = [];
  let key = 0;

  let i = 0;
  while (i < lines.length) {
    const line = lines[i];

    // Fenced code block
    if (line.startsWith("```")) {
      const lang = line.slice(3).trim();
      const codeLines: string[] = [];
      i++;
      while (i < lines.length && !lines[i].startsWith("```")) {
        codeLines.push(lines[i]);
        i++;
      }
      i++; // skip closing ```
      out.push(
        <pre key={key++} style={preStyle}>
          <code data-lang={lang}>{codeLines.join("\n")}</code>
        </pre>,
      );
      continue;
    }

    // Heading
    const h = line.match(/^(#{1,6})\s+(.+)$/);
    if (h) {
      const level = h[1].length;
      const text = h[2];
      const tag = `h${level}` as keyof React.JSX.IntrinsicElements;
      const Tag = tag;
      out.push(
        <Tag key={key++} style={headingStyle(level)}>
          {renderInline(text)}
        </Tag>,
      );
      i++;
      continue;
    }

    // Blockquote
    if (line.startsWith("> ")) {
      const quoteLines: string[] = [];
      while (i < lines.length && lines[i].startsWith("> ")) {
        quoteLines.push(lines[i].slice(2));
        i++;
      }
      out.push(
        <blockquote key={key++} style={blockquoteStyle}>
          {renderInline(quoteLines.join(" "))}
        </blockquote>,
      );
      continue;
    }

    // Bulleted list
    if (line.match(/^[-*+]\s+/)) {
      const items: string[] = [];
      while (i < lines.length && lines[i].match(/^[-*+]\s+/)) {
        items.push(lines[i].replace(/^[-*+]\s+/, ""));
        i++;
      }
      out.push(
        <ul key={key++} style={listStyle}>
          {items.map((it, idx) => (
            <li key={idx}>{renderInline(it)}</li>
          ))}
        </ul>,
      );
      continue;
    }

    // Ordered list
    if (line.match(/^\d+\.\s+/)) {
      const items: string[] = [];
      while (i < lines.length && lines[i].match(/^\d+\.\s+/)) {
        items.push(lines[i].replace(/^\d+\.\s+/, ""));
        i++;
      }
      out.push(
        <ol key={key++} style={listStyle}>
          {items.map((it, idx) => (
            <li key={idx}>{renderInline(it)}</li>
          ))}
        </ol>,
      );
      continue;
    }

    // Horizontal rule
    if (line.match(/^---+\s*$/)) {
      out.push(<hr key={key++} style={hrStyle} />);
      i++;
      continue;
    }

    // Blank line
    if (line.trim() === "") {
      i++;
      continue;
    }

    // Paragraph (collect contiguous non-blank, non-special lines)
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
        {renderInline(paraLines.join(" "))}
      </p>,
    );
  }

  return out;
}

function renderInline(text: string): React.ReactNode {
  // Order matters: do code first (so we don't try to bold inside code).
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
    // Inline code
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
    // Bold
    if (text.startsWith("**", i)) {
      const end = text.indexOf("**", i + 2);
      if (end > i + 1) {
        flushBuf();
        parts.push(<strong key={key++}>{renderInline(text.slice(i + 2, end))}</strong>);
        i = end + 2;
        continue;
      }
    }
    // Italic
    if (text[i] === "*") {
      const end = text.indexOf("*", i + 1);
      if (end > i) {
        flushBuf();
        parts.push(<em key={key++}>{renderInline(text.slice(i + 1, end))}</em>);
        i = end + 1;
        continue;
      }
    }
    // Link [text](url) -- rewrite intra-doc .md links to navigate the Help tab
    if (text[i] === "[") {
      const closeBracket = text.indexOf("]", i + 1);
      if (closeBracket > i && text[closeBracket + 1] === "(") {
        const closeParen = text.indexOf(")", closeBracket + 2);
        if (closeParen > closeBracket) {
          flushBuf();
          const linkText = text.slice(i + 1, closeBracket);
          const rawUrl = text.slice(closeBracket + 2, closeParen);
          const helpHref = rewriteLink(rawUrl);
          parts.push(
            <a key={key++} href={helpHref} target={helpHref.startsWith("#") ? undefined : "_blank"} rel="noopener noreferrer">
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

/**
 * Rewrite intra-doc `.md` links so they open the corresponding Help
 * topic in the same tab instead of triggering a 404 fetch. External
 * URLs (https://, etc.) are left as-is.
 */
function rewriteLink(url: string): string {
  if (url.startsWith("http://") || url.startsWith("https://")) return url;
  // Strip ../something/ prefixes -- we only care about the basename.
  const basename = url.replace(/.*\//, "").replace(/#.*$/, "");
  const slugMap: Record<string, string> = {
    "manual.md": "manual",
    "workflow.md": "workflow",
    "cli-usage.md": "cli",
    "clio-quickstart.md": "clio",
    "installing.md": "installing",
    "troubleshooting.md": "troubleshooting",
    "server-api.md": "api",
  };
  const slug = slugMap[basename];
  if (slug) {
    // Preserve the anchor (#section) if present.
    const anchorMatch = url.match(/#(.+)$/);
    return `#/help/${slug}${anchorMatch ? "#" + anchorMatch[1] : ""}`;
  }
  return url;
}

// ── Styles ──────────────────────────────────────────────────────────────
// Inline styles using the theme tokens defined in packages/web/src/
// styles/app.css (--color-bg, --color-surface, --color-text, etc.).
// This keeps the Help tab's contrast correct in the cfcf dark theme
// (the only theme today). Hardcoded #-colors here would render
// unreadable on the dark background -- which is exactly what shipped
// in v0.14.0 and is the bug this revision fixes.

const pageStyle: React.CSSProperties = {
  display: "grid",
  gridTemplateColumns: "260px 1fr",
  gap: "24px",
  padding: "16px 24px",
  alignItems: "start",
  color: "var(--color-text)",
};
const asideStyle: React.CSSProperties = {
  position: "sticky",
  top: 16,
  borderRight: "1px solid var(--color-border)",
  paddingRight: "12px",
};
const asideHeadingStyle: React.CSSProperties = {
  fontSize: "0.95rem",
  margin: "0 0 12px 0",
  color: "var(--color-text-muted)",
  textTransform: "uppercase",
  letterSpacing: "0.05em",
};
const topicListStyle: React.CSSProperties = {
  listStyle: "none",
  padding: 0,
  margin: 0,
};
const topicButtonStyle = (active: boolean): React.CSSProperties => ({
  display: "block",
  width: "100%",
  textAlign: "left",
  padding: "8px 10px",
  marginBottom: "4px",
  border: "none",
  borderRadius: "var(--radius)",
  cursor: "pointer",
  background: active ? "color-mix(in srgb, var(--color-primary) 18%, transparent)" : "transparent",
  color: active ? "var(--color-primary-hover)" : "var(--color-text)",
  fontFamily: "inherit",
  fontSize: "0.95rem",
});
const slugStyle: React.CSSProperties = {
  display: "block",
  fontSize: "0.8rem",
  color: "var(--color-text-muted)",
  fontFamily: "var(--font-mono)",
  marginTop: "2px",
};
const tipStyle: React.CSSProperties = {
  marginTop: "20px",
  fontSize: "0.85rem",
  color: "var(--color-text-muted)",
};

const articleStyle: React.CSSProperties = {
  maxWidth: "860px",
  paddingLeft: "8px",
};
const metaStyle: React.CSSProperties = {
  fontSize: "0.85rem",
  color: "var(--color-text-muted)",
  marginBottom: "16px",
  display: "flex",
  gap: "16px",
};
const errorStyle: React.CSSProperties = {
  padding: "16px",
  background: "color-mix(in srgb, var(--color-error) 12%, transparent)",
  border: "1px solid color-mix(in srgb, var(--color-error) 50%, transparent)",
  borderRadius: "var(--radius)",
  color: "var(--color-text)",
};

const mdRootStyle: React.CSSProperties = {
  lineHeight: 1.6,
  color: "var(--color-text)",
};
const headingStyle = (level: number): React.CSSProperties => ({
  marginTop: level === 1 ? "0" : "28px",
  marginBottom: "12px",
  fontSize: ["", "1.8rem", "1.4rem", "1.15rem", "1.05rem", "1rem", "0.95rem"][level],
  fontWeight: level <= 2 ? 700 : 600,
  color: "var(--color-text)",
  borderBottom: level === 1 || level === 2 ? "1px solid var(--color-border)" : undefined,
  paddingBottom: level === 1 || level === 2 ? "6px" : undefined,
});
const paraStyle: React.CSSProperties = { margin: "0 0 14px 0" };
const preStyle: React.CSSProperties = {
  background: "var(--color-surface-alt)",
  border: "1px solid var(--color-border)",
  borderRadius: "var(--radius)",
  padding: "12px 14px",
  margin: "10px 0 14px 0",
  fontSize: "0.85rem",
  fontFamily: "var(--font-mono)",
  color: "var(--color-text)",
  overflowX: "auto",
  whiteSpace: "pre",
};
const inlineCodeStyle: React.CSSProperties = {
  background: "color-mix(in srgb, var(--color-border) 60%, transparent)",
  color: "var(--color-info)",
  padding: "1px 5px",
  borderRadius: "var(--radius-sm)",
  fontSize: "0.9em",
  fontFamily: "var(--font-mono)",
};
const blockquoteStyle: React.CSSProperties = {
  borderLeft: "4px solid var(--color-border)",
  margin: "12px 0",
  padding: "4px 16px",
  color: "var(--color-text-muted)",
  fontStyle: "italic",
};
const listStyle: React.CSSProperties = {
  margin: "0 0 14px 0",
  paddingLeft: "24px",
};
const hrStyle: React.CSSProperties = {
  border: "none",
  borderTop: "1px solid var(--color-border)",
  margin: "20px 0",
};
