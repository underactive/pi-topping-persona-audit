import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { homedir } from "node:os";
import * as path from "node:path";
import { formatAge, formatBytes, type ArtifactEntry, type ArtifactKind } from "../artifacts.ts";
import { MenuComponent, showWidgetPrompt, type MenuSection, type ToggleMenuItem } from "./menuChrome.ts";

export const PURGE_MENU_WIDGET_KEY = "persona-audit-purge";

export type PurgeMenuResult =
  | { action: "purge"; tagged: Set<string> }
  | { action: "preview"; entry: ArtifactEntry; tagged: Set<string> }
  | undefined;

const SECTION_INFO: Record<ArtifactKind, { title: string; description: string }> = {
  report: {
    title: "Audit reports",
    description: "Final audit results. Keep these if you need a permanent record of findings, fixes, and verification.",
  },
  progress: {
    title: "Progress snapshots",
    description: "Partial reports saved while an audit runs. Useful for recovering completed reviewer work after cancellation or failure.",
  },
  handoff: {
    title: "Handoffs",
    description: "Deferred findings saved for later review. Resumable handoffs can restart an audit from those findings.",
  },
  "snapshot-set": {
    title: "Pre-fix snapshots",
    description: "Copies of files before accepted fixes. They support fix verification and are not needed after the audit is complete.",
  },
  cache: {
    title: "Reviewer cache (this repo — deleting forces fresh reviewer passes)",
    description: "Cached reviewer outputs for unchanged runs. Delete only to reclaim space or force fresh reviewer passes.",
  },
};

function label(entry: ArtifactEntry): string {
  return [entry.displayPath, formatBytes(entry.sizeBytes), formatAge(entry.mtimeMs), entry.detail].filter(Boolean).join(" · ");
}

export function displayDirectory(absPath: string): string {
  const directory = path.dirname(absPath);
  const home = homedir();
  return directory === home ? "~" : directory.startsWith(`${home}${path.sep}`) ? `~${directory.slice(home.length)}` : directory;
}

export function showPurgeMenu(
  ctx: ExtensionCommandContext,
  entries: ArtifactEntry[],
  preTagged: Set<string>,
  preserveCacheTags = false,
): Promise<PurgeMenuResult> {
  const tagged = new Map<string, boolean>();
  const entryById = new Map(entries.map((entry) => [entry.id, entry]));
  const selectedIds = () => new Set([...tagged].flatMap(([id, value]) => (value ? [id] : [])));
  const sections: MenuSection[] = (Object.keys(SECTION_INFO) as ArtifactKind[]).flatMap((kind) => {
    const matching = entries.filter((entry) => entry.kind === kind);
    if (matching.length === 0) return [];
    const items: ToggleMenuItem[] = matching.map((entry) => ({
      id: entry.id,
      label: label(entry),
      value: kind === "cache" && !preserveCacheTags ? false : preTagged.has(entry.id),
      onChange: (value) => tagged.set(entry.id, value),
    }));
    for (const item of items) tagged.set(item.id, item.value);
    return [{ ...SECTION_INFO[kind], title: `${SECTION_INFO[kind].title} · ${displayDirectory(matching[0]!.absPath)}`, items }];
  });

  return showWidgetPrompt<PurgeMenuResult>(ctx, PURGE_MENU_WIDGET_KEY, (tui, theme, finish) =>
    new MenuComponent(
      {
        title: "Persona-audit: Purge artifacts",
        fullWidth: true,
        maxItemsPerSection: 8,
        sections,
        hints: ["↑↓ item", "space tag", "p preview", "⇥ buttons", "⏎ select", "esc cancel"],
        onItemKey: (item, data) => {
          if (data !== "p" && data !== "P") return false;
          const entry = entryById.get(item.id);
          if (!entry) return false;
          finish({ action: "preview", entry, tagged: selectedIds() });
          return true;
        },
        buttons: [
          {
            id: "purge",
            label: "Purge tagged",
            primary: true,
            onSelect: () => finish({ action: "purge", tagged: selectedIds() }),
          },
          { id: "cancel", label: "Cancel", onSelect: () => finish(undefined) },
        ],
      },
      theme,
      () => finish(undefined),
      tui,
    ));
}
