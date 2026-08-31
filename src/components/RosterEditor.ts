import type { ExtensionCommandContext, Theme } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, type Component, type SelectItem } from "@earendil-works/pi-tui";
import {
  MAX_ROSTER_COUNT,
  MAX_ROSTER_NAME_LENGTH,
  MAX_ROSTER_SIZE,
  ROSTER_NAME_PATTERN,
  type Roster,
} from "../modelConfig.ts";
import { ConsistentSelectList } from "./ModelPicker.ts";
import { TIERS } from "./ReviewerData.ts";
import { MenuComponent, showOverlayPrompt, type ActionMenuItem } from "./menuChrome.ts";

const REVIEWER_NAMES = TIERS.flatMap((tier) => tier.reviewers.map((reviewer) => reviewer.name));

type DraftRoster = { name: string; slots: Array<string | undefined> };
type ListResult = { action: "create" } | { action: "edit"; index: number } | { action: "back" };
type EditorResult =
  | { action: "save"; draft: DraftRoster }
  | { action: "pick"; slot: number; draft: DraftRoster }
  | { action: "rename"; draft: DraftRoster }
  | { action: "delete" }
  | { action: "cancel" };

function cloneRoster(roster: Roster): Roster {
  return { name: roster.name, reviewers: [...roster.reviewers] };
}

function toDraft(roster: Roster): DraftRoster {
  return { name: roster.name, slots: Array.from({ length: MAX_ROSTER_SIZE }, (_, index) => roster.reviewers[index]) };
}

function cloneDraft(draft: DraftRoster): DraftRoster {
  return { name: draft.name, slots: [...draft.slots] };
}

function fromDraft(draft: DraftRoster): Roster {
  return { name: draft.name, reviewers: draft.slots.filter((name): name is string => name !== undefined) };
}

export function rosterNameError(name: string, rosters: Roster[], currentIndex?: number): string | undefined {
  if (name.length < 1 || name.length > MAX_ROSTER_NAME_LENGTH || !ROSTER_NAME_PATTERN.test(name)) {
    return `Roster names must be 1–${MAX_ROSTER_NAME_LENGTH} alphanumeric characters.`;
  }
  if (rosters.some((roster, index) => index !== currentIndex && roster.name.toLowerCase() === name.toLowerCase())) {
    return `A roster named ${name} already exists.`;
  }
  return undefined;
}

async function promptRosterName(
  ctx: ExtensionCommandContext,
  rosters: Roster[],
  currentName = "",
  currentIndex?: number,
): Promise<string | undefined> {
  for (;;) {
    const entered = await ctx.ui.input("Roster name", currentName || `1–${MAX_ROSTER_NAME_LENGTH} letters or numbers`);
    if (entered === undefined) return undefined;
    const name = entered.trim();
    const error = rosterNameError(name, rosters, currentIndex);
    if (!error) return name;
    ctx.ui.notify(error, "warning");
  }
}

function showRosterList(ctx: ExtensionCommandContext, rosters: Roster[]): Promise<ListResult> {
  return showOverlayPrompt(ctx, (tui, theme, finish) => {
    const items: ActionMenuItem[] = rosters
      .map((roster, index) => ({ roster, index }))
      .sort((a, b) => a.roster.name.localeCompare(b.roster.name))
      .map(({ roster, index }) => ({
        id: `roster-${index}`,
        label: roster.name,
        displayValue: `${roster.reviewers.length} member${roster.reviewers.length === 1 ? "" : "s"}`,
        description: roster.reviewers.join(", "),
        onSelect: () => finish({ action: "edit", index }),
      }));
    if (rosters.length < MAX_ROSTER_COUNT) {
      items.push({ id: "create", label: "Create roster", onSelect: () => finish({ action: "create" }) });
    }
    return new MenuComponent(
      {
        title: "Persona-audit: Reviewer rosters",
        fullWidth: true,
        maxItemsPerSection: 8,
        sections: [{ title: "Rosters", items }],
        buttons: [{ id: "back", label: "Back", primary: true, onSelect: () => finish({ action: "back" }) }],
      }, theme, () => finish({ action: "back" }), tui,
    );
  });
}

function showSlotEditor(
  ctx: ExtensionCommandContext,
  draft: DraftRoster,
  focusSlot: number,
  canDelete: boolean,
): Promise<EditorResult> {
  const working = cloneDraft(draft);
  return showOverlayPrompt(ctx, (tui, theme, finish) => {
    const items: ActionMenuItem[] = working.slots.map((reviewer, index) => ({
      id: `slot-${index}`,
      label: `Slot ${index + 1}`,
      displayValue: reviewer ?? "(none)",
      onSelect: () => finish({ action: "pick", slot: index, draft: cloneDraft(working) }),
    }));
    return new MenuComponent(
      {
        title: `Reviewer roster: ${working.name}`,
        fullWidth: true,
        maxItemsPerSection: MAX_ROSTER_SIZE,
        initialItemId: `slot-${focusSlot}`,
        hints: ["↑↓ slot", "⏎ choose", "⌫ clear", "⇥ buttons", "esc cancel"],
        sections: [{ title: "Reviewers", items }],
        onItemKey: (item, data) => {
          if (data !== "\x7f" && data !== "\b" && !matchesKey(data, Key.delete)) return false;
          const slot = Number(item.id.slice("slot-".length));
          if (Number.isInteger(slot)) {
            working.slots[slot] = undefined;
            if (items[slot]) items[slot]!.displayValue = "(none)";
          }
          return true;
        },
        buttons: [
          {
            id: "save", label: "Save roster", primary: true,
            onSelect: () => {
              if (!working.slots.some(Boolean)) {
                ctx.ui.notify("A roster must contain at least one reviewer.", "warning");
                return;
              }
              finish({ action: "save", draft: cloneDraft(working) });
            },
          },
          { id: "rename", label: "Rename", onSelect: () => finish({ action: "rename", draft: cloneDraft(working) }) },
          ...(canDelete ? [{ id: "delete", label: "Delete", onSelect: () => finish({ action: "delete" } as const) }] : []),
          { id: "cancel", label: "Cancel", onSelect: () => finish({ action: "cancel" }) },
        ],
      }, theme, () => finish({ action: "cancel" }), tui,
    );
  });
}

class ReviewerSelectComponent implements Component {
  private readonly list: ConsistentSelectList;
  private filter = "";

  constructor(items: SelectItem[], theme: Theme, done: (reviewer: string | undefined) => void) {
    this.list = new ConsistentSelectList(items, 10, theme);
    this.list.onSelect = (item) => done(item.value);
    this.list.onCancel = () => done(undefined);
  }
  handleInput(data: string): void {
    if (data === "\x7f" || data === "\b") {
      this.filter = this.filter.slice(0, -1);
      this.list.setFilter(this.filter);
      return;
    }
    if (data.length === 1 && data >= " " && data !== "\x7f") {
      this.filter += data;
      this.list.setFilter(this.filter);
      return;
    }
    this.list.handleInput(data);
  }
  render(width: number): string[] { return this.list.render(width); }
  invalidate(): void { this.list.invalidate(); }
}

function showReviewerPicker(ctx: ExtensionCommandContext, draft: DraftRoster, slot: number): Promise<string | undefined> {
  const excluded = new Set(draft.slots.filter((name, index): name is string => index !== slot && name !== undefined));
  const items = REVIEWER_NAMES.filter((name) => !excluded.has(name)).map((name) => ({ value: name, label: name }));
  return showOverlayPrompt(ctx, (_tui, theme, finish) => new ReviewerSelectComponent(items, theme, finish));
}

async function editRoster(
  ctx: ExtensionCommandContext,
  rosters: Roster[],
  roster: Roster,
  currentIndex?: number,
): Promise<Roster | "delete" | undefined> {
  let draft = toDraft(roster);
  let focusSlot = 0;
  for (;;) {
    const result = await showSlotEditor(ctx, draft, focusSlot, currentIndex !== undefined);
    if (result.action === "cancel") return undefined;
    if (result.action === "save") return fromDraft(result.draft);
    if (result.action === "delete") {
      if (await ctx.ui.confirm("Delete reviewer roster?", `Delete ${draft.name}? This is staged until settings are saved.`)) return "delete";
      continue;
    }
    if (result.action === "rename") {
      const name = await promptRosterName(ctx, rosters, result.draft.name, currentIndex);
      draft = { ...result.draft, name: name ?? result.draft.name };
      continue;
    }
    focusSlot = result.slot;
    const reviewer = await showReviewerPicker(ctx, result.draft, result.slot);
    draft = cloneDraft(result.draft);
    if (reviewer !== undefined) draft.slots[result.slot] = reviewer;
  }
}

/** Manage a staged roster collection; persistence remains the top-level settings Save action's responsibility. */
export async function showRosterManager(ctx: ExtensionCommandContext, initial: Roster[]): Promise<Roster[]> {
  const rosters = initial.map(cloneRoster);
  for (;;) {
    const action = await showRosterList(ctx, rosters);
    if (action.action === "back") return rosters;
    if (action.action === "create") {
      const name = await promptRosterName(ctx, rosters);
      if (!name) continue;
      const created = await editRoster(ctx, rosters, { name, reviewers: [] });
      if (created && created !== "delete") rosters.push(created);
      continue;
    }
    const current = rosters[action.index];
    if (!current) continue;
    const edited = await editRoster(ctx, rosters, current, action.index);
    if (edited === "delete") rosters.splice(action.index, 1);
    else if (edited) rosters[action.index] = edited;
  }
}
