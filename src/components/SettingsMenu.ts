/**
 * Settings menu for /persona-audit-settings.
 *
 * Covers the progress table's activity meter — the MONITOR column — the Linus
 * Torvalds reviewer's register, and the fix→verify round cap. Values are chosen
 * inline with the left/right keys and committed with the Save button; Esc closes
 * without writing, since this is the only screen and has nowhere to step back to.
 */

import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { MenuComponent, showOverlayPrompt, type MenuItem } from "./menuChrome.ts";
import {
  MAX_VERIFY_ROUNDS,
  METER_COLORS,
  METER_DIRECTIONS,
  MIN_VERIFY_ROUNDS,
  TEMPERAMENTS,
  type MeterDirection,
  type PersonaAuditConfig,
  type Temperament,
} from "../modelConfig.ts";

/** Direction labels, keyed by `MeterDirection` value. */
const DIRECTION_LABELS: Record<MeterDirection, string> = {
  ltr: "Left to Right",
  rtl: "Right to Left",
};

/** Temperament labels, keyed by `Temperament` value. */
const TEMPERAMENT_LABELS: Record<Temperament, string> = {
  calibrated: "neutral (min)",
  caustic: "caustic",
  lkml: "LKML (max)",
};

/** The selectable round counts, MIN..MAX, as the display strings the row cycles through. */
const VERIFY_ROUND_VALUES: string[] = Array.from(
  { length: MAX_VERIFY_ROUNDS - MIN_VERIFY_ROUNDS + 1 },
  (_, i) => String(i + MIN_VERIFY_ROUNDS),
);

export type SettingsMenuResult =
  | { action: "save"; draft: PersonaAuditConfig }
  | { action: "rosters"; draft: PersonaAuditConfig }
  | { action: "cancel" };

function cloneConfig(config: PersonaAuditConfig): PersonaAuditConfig {
  return {
    ...config,
    meter: { ...config.meter },
    rosters: config.rosters.map((roster) => ({ ...roster, reviewers: [...roster.reviewers] })),
  };
}

/** Show one settings screen. Roster management resolves so the caller can open its sequential overlay. */
export function showSettingsMenu(
  ctx: ExtensionCommandContext,
  initial: PersonaAuditConfig,
): Promise<SettingsMenuResult> {
  const draft = cloneConfig(initial);

  return showOverlayPrompt<SettingsMenuResult>(ctx, (tui, theme, finish) => {
    const items: MenuItem[] = [
      {
        id: "meterColor",
        label: "Token activity monitor color",
        values: [...METER_COLORS],
        valueIndex: METER_COLORS.indexOf(draft.meter.color),
        compact: true,
        onChange: (index: number) => {
          draft.meter.color = METER_COLORS[index]!;
        },
      },
      {
        id: "meterDirection",
        label: "Token activity monitor direction",
        values: METER_DIRECTIONS.map((direction) => DIRECTION_LABELS[direction]),
        valueIndex: METER_DIRECTIONS.indexOf(draft.meter.direction),
        compact: true,
        onChange: (index: number) => {
          draft.meter.direction = METER_DIRECTIONS[index]!;
        },
      },
      {
        id: "temperament",
        label: "Linus Torvalds temperament",
        values: TEMPERAMENTS.map((temperament) => TEMPERAMENT_LABELS[temperament]),
        valueIndex: TEMPERAMENTS.indexOf(draft.temperament),
        compact: true,
        onChange: (index: number) => {
          draft.temperament = TEMPERAMENTS[index]!;
        },
      },
      {
        id: "maxVerifyRounds",
        label: "Max fix + verify rounds",
        description: `Round 1 verifies; the rest auto-repair. ${MIN_VERIFY_ROUNDS} turns auto-repair off.`,
        values: VERIFY_ROUND_VALUES,
        valueIndex: draft.maxVerifyRounds - MIN_VERIFY_ROUNDS,
        compact: true,
        onChange: (index: number) => {
          draft.maxVerifyRounds = index + MIN_VERIFY_ROUNDS;
        },
      },
      {
        id: "rosters",
        label: "Reviewer rosters",
        displayValue: `${draft.rosters.length} configured`,
        description: "Create or edit reusable reviewer combinations.",
        onSelect: () => finish({ action: "rosters", draft: cloneConfig(draft) }),
      },
    ];

    return new MenuComponent(
      {
        title: "Persona-audit: Settings",
        fullWidth: true,
        sections: [{ title: "", items }],
        buttons: [
          { id: "save", label: "Save", primary: true, onSelect: () => finish({ action: "save", draft: cloneConfig(draft) }) },
          { id: "cancel", label: "Cancel", onSelect: () => finish({ action: "cancel" }) },
        ],
      },
      theme,
      () => finish({ action: "cancel" }),
      tui,
    );
  });
}
