import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { formatAge, formatBytes, type ArtifactEntry, type ArtifactKind } from "../artifacts.ts";
import { MenuComponent, showWidgetPrompt, type MenuSection, type ToggleMenuItem } from "./menuChrome.ts";

export const PURGE_MENU_WIDGET_KEY = "persona-audit-purge";

const TITLES: Record<ArtifactKind, string> = {
  report: "Audit reports",
  progress: "Progress snapshots",
  handoff: "Handoffs",
  "snapshot-set": "Pre-fix snapshots",
  cache: "Reviewer cache (this repo — deleting forces fresh reviewer passes)",
};

function label(entry: ArtifactEntry): string {
  return [entry.displayPath, formatBytes(entry.sizeBytes), formatAge(entry.mtimeMs), entry.detail].filter(Boolean).join(" · ");
}

export function showPurgeMenu(
  ctx: ExtensionCommandContext,
  entries: ArtifactEntry[],
  preTagged: Set<string>,
): Promise<Set<string> | undefined> {
  const tagged = new Map<string, boolean>();
  const sections: MenuSection[] = (Object.keys(TITLES) as ArtifactKind[]).flatMap((kind) => {
    const matching = entries.filter((entry) => entry.kind === kind);
    if (matching.length === 0) return [];
    const items: ToggleMenuItem[] = matching.map((entry) => ({
      id: entry.id,
      label: label(entry),
      value: kind === "cache" ? false : preTagged.has(entry.id),
      onChange: (value) => tagged.set(entry.id, value),
    }));
    for (const item of items) tagged.set(item.id, item.value);
    return [{ title: TITLES[kind], items }];
  });

  return showWidgetPrompt<Set<string> | undefined>(ctx, PURGE_MENU_WIDGET_KEY, (tui, theme, finish) =>
    new MenuComponent(
      {
        title: "Persona-audit: Purge artifacts",
        fullWidth: true,
        maxItemsPerSection: 8,
        sections,
        hints: ["↑↓ item", "space tag", "⇥ buttons", "⏎ select", "esc cancel"],
        buttons: [
          {
            id: "purge",
            label: "Purge tagged",
            primary: true,
            onSelect: () => finish(new Set([...tagged].flatMap(([id, value]) => (value ? [id] : [])))),
          },
          { id: "cancel", label: "Cancel", onSelect: () => finish(undefined) },
        ],
      },
      theme,
      () => finish(undefined),
      tui,
    ));
}
