import { useState } from "react";
import { useRoute, type MemoryTab } from "../hooks/useRoute";
import { TabBar } from "../components/TabBar";
import { MemorySidebar } from "./memory/MemorySidebar";
import { SearchTab } from "./memory/SearchTab";
import { BrowseTab } from "./memory/BrowseTab";
import { IngestTab } from "./memory/IngestTab";
import { AuditTab } from "./memory/AuditTab";
import { ProjectsTab } from "./memory/ProjectsTab";
import { TrashTab } from "./memory/TrashTab";
import { DocumentDetail } from "./memory/DocumentDetail";

const TABS: { key: MemoryTab; label: string }[] = [
  { key: "search", label: "Search" },
  { key: "browse", label: "Browse" },
  { key: "ingest", label: "Ingest" },
  { key: "audit", label: "Audit" },
  { key: "projects", label: "Projects" },
  { key: "trash", label: "Trash" },
];

/**
 * Clio "Memory" top-level page (item 6.18, building on 6.12 prototype).
 *
 * Layout: persistent left sidebar (Stats + Projects filter) + tabbed
 * main panel. Tabs cover the user-facing operations the agents'
 * `cfcf clio` CLI exposes, plus a UI-specific Search affordance with
 * a documents-vs-chunks result-type picker.
 *
 * Routing: `#/memory?tab=<tab>&doc=<doc-id>`. The `tab` query selects
 * the visible sub-view; the `doc` query opens the DocumentDetail
 * overlay on top of whichever tab is active. Both are reflected in
 * the URL so deep links + browser-back work.
 *
 * Ingest tracking: a single `corpusRefreshTick` keys both the sidebar's
 * stats panel + listings (Browse, Trash) on every corpus mutation
 * (ingest, edit, soft-delete, restore, purge, project CRUD). The
 * Memory page bumps the tick from one place — children just consume
 * it. Round-4 of 6.18 added the Trash tab + delete refresh into this
 * model so the list always reflects the latest server state without a
 * full page reload.
 */
export function MemoryPage() {
  const route = useRoute();
  const activeTab: MemoryTab = route.memoryTab ?? "search";
  const [activeProject, setActiveProject] = useState<string | null>(null);
  const [corpusRefreshTick, setCorpusRefreshTick] = useState(0);

  function navigateToTab(tab: MemoryTab) {
    const docPart = route.memoryDocId ? `&doc=${encodeURIComponent(route.memoryDocId)}` : "";
    window.location.hash = `/memory?tab=${tab}${docPart}`;
  }

  function openDoc(id: string) {
    window.location.hash = `/memory?tab=${activeTab}&doc=${encodeURIComponent(id)}`;
  }

  function closeDoc() {
    window.location.hash = `/memory?tab=${activeTab}`;
  }

  function bumpCorpus() {
    setCorpusRefreshTick((n) => n + 1);
  }

  return (
    <div>
      <div style={{ marginBottom: "1rem" }}>
        <h2 style={{ margin: 0 }}>Memory</h2>
        <p style={{ marginTop: "0.25rem", marginBottom: 0, fontSize: "var(--text-sm)", color: "var(--color-text-muted)" }}>
          Browse, search, and curate Clio — the cross-workspace knowledge layer.
          Agents read and write through <code>cfcf clio</code>; this page is the human surface.
        </p>
      </div>

      <div className="memory-page">
        <MemorySidebar
          activeProject={activeProject}
          onSelectProject={setActiveProject}
          refreshTick={corpusRefreshTick}
        />

        <main className="memory-page__main">
          <TabBar
            tabs={TABS}
            active={activeTab}
            onChange={(t) => navigateToTab(t as MemoryTab)}
          />
          <div style={{ marginTop: "1rem" }}>
            {activeTab === "search" && (
              <SearchTab activeProject={activeProject} onOpenDoc={openDoc} />
            )}
            {activeTab === "browse" && (
              <BrowseTab
                project={activeProject}
                onSelect={openDoc}
                refreshTick={corpusRefreshTick}
              />
            )}
            {activeTab === "ingest" && (
              <IngestTab
                activeProject={activeProject}
                onIngested={(id) => { bumpCorpus(); openDoc(id); }}
              />
            )}
            {activeTab === "audit" && (
              <AuditTab activeProject={activeProject} />
            )}
            {activeTab === "projects" && (
              <ProjectsTab onCreated={bumpCorpus} />
            )}
            {activeTab === "trash" && (
              <TrashTab
                project={activeProject}
                onSelect={openDoc}
                refreshTick={corpusRefreshTick}
                onChanged={bumpCorpus}
              />
            )}
          </div>
        </main>
      </div>

      {route.memoryDocId && (
        <DocumentDetail
          documentId={route.memoryDocId}
          onClose={closeDoc}
          onChanged={bumpCorpus}
        />
      )}
    </div>
  );
}
