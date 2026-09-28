import React, { useEffect, useState } from "react";
import Markdown from "react-markdown";
import remarkMath from "remark-math";
import rehypeMathjax from "rehype-mathjax/browser";
// PrismLight ships ZERO language grammars. The full `Prism` build bundles all
// ~270 refractor languages and walks every grammar at module-eval time — a
// ~400ms recursive-DFS main-thread block that fired on initial load whenever
// transcribed results were restored from IndexedDB. We register only the
// languages Gemini output realistically produces; any unregistered fence
// (e.g. ```go) falls back to plain, unstyled text gracefully.
import { PrismLight as SyntaxHighlighter } from "react-syntax-highlighter";
import { vscDarkPlus } from "react-syntax-highlighter/dist/esm/styles/prism";
import json from "react-syntax-highlighter/dist/esm/languages/prism/json";
import bash from "react-syntax-highlighter/dist/esm/languages/prism/bash";
import python from "react-syntax-highlighter/dist/esm/languages/prism/python";
import javascript from "react-syntax-highlighter/dist/esm/languages/prism/javascript";
import typescript from "react-syntax-highlighter/dist/esm/languages/prism/typescript";
import jsx from "react-syntax-highlighter/dist/esm/languages/prism/jsx";
import tsx from "react-syntax-highlighter/dist/esm/languages/prism/tsx";
import markdown from "react-syntax-highlighter/dist/esm/languages/prism/markdown";
import markup from "react-syntax-highlighter/dist/esm/languages/prism/markup";
import css from "react-syntax-highlighter/dist/esm/languages/prism/css";
import sql from "react-syntax-highlighter/dist/esm/languages/prism/sql";

SyntaxHighlighter.registerLanguage("json", json);
SyntaxHighlighter.registerLanguage("bash", bash);
SyntaxHighlighter.registerLanguage("shell", bash);
SyntaxHighlighter.registerLanguage("python", python);
SyntaxHighlighter.registerLanguage("javascript", javascript);
SyntaxHighlighter.registerLanguage("typescript", typescript);
SyntaxHighlighter.registerLanguage("jsx", jsx);
SyntaxHighlighter.registerLanguage("tsx", tsx);
SyntaxHighlighter.registerLanguage("markdown", markdown);
SyntaxHighlighter.registerLanguage("markup", markup);
SyntaxHighlighter.registerLanguage("html", markup);
SyntaxHighlighter.registerLanguage("css", css);
SyntaxHighlighter.registerLanguage("sql", sql);

interface ResultMarkdownRendererProps {
  text: string;
}

export default function ResultMarkdownRenderer({ text }: ResultMarkdownRendererProps) {
  const [mathjaxReady, setMathjaxReady] = useState(false);

  useEffect(() => {
    // If MathJax config isn't defined on window, define it
    if (typeof window !== "undefined") {
      if (!(window as any).MathJax) {
        (window as any).MathJax = {
          tex: {
            inlineMath: [['$', '$'], ['\\(', '\\)']],
            displayMath: [['$$', '$$'], ['\\[', '\\]']]
          },
          svg: {
            fontCache: 'global'
          }
        };
      }

      // Check if MathJax script is already in the document
      const existingScript = document.getElementById("MathJax-script");
      if (!existingScript) {
        const script = document.createElement("script");
        script.id = "MathJax-script";
        script.src = "https://cdn.jsdelivr.net/npm/mathjax@3/es5/tex-svg.js";
        script.async = true;
        script.onload = () => {
          setMathjaxReady(true);
        };
        script.onerror = () => {
          console.warn("Failed to dynamically load MathJax CDN.");
          setMathjaxReady(true); // fall back gracefully
        };
        document.head.appendChild(script);
      } else {
        setMathjaxReady(true);
      }
    }
  }, []);

  return (
    <Markdown
      remarkPlugins={[remarkMath]}
      rehypePlugins={[rehypeMathjax]}
      components={{
        code({
          node,
          inline,
          className,
          children,
          ...props
        }: any) {
          const match = /language-(\w+)/.exec(className || "");
          return !inline && match ? (
            <div className="relative group rounded-xl overflow-hidden my-4 border border-slate-200 dark:border-slate-800 shadow-sm">
              <div className="flex items-center justify-between px-4 py-2 bg-slate-800 dark:bg-slate-950 text-slate-300 dark:text-slate-300 text-xs font-mono border-b border-slate-800">
                <span>{match[1]}</span>
              </div>
              <SyntaxHighlighter
                {...props}
                children={String(children).replace(/\n$/, "")}
                style={vscDarkPlus}
                language={match[1]}
                PreTag="div"
                customStyle={{
                  margin: 0,
                  borderRadius: 0,
                  background: "#1e1e1e",
                }}
              />
            </div>
          ) : (
            <code {...props} className={className}>
              {children}
            </code>
          );
        },
      }}
    >
      {text}
    </Markdown>
  );
}
