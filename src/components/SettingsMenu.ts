/**
 * Settings menu for /persona-audit-settings.
 *
 * Covers the progress table's activity meter — the MONITOR column — the Linus
 * Torvalds reviewer's register, and the fix→verify round cap. Values are chosen
 * inline with the left/right keys and committed with the Save button; Esc closes
 * without writing, since this is the only screen and has nowhere to step back to.
 */

import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { MenuComponent, showWidgetPrompt, type ChoiceMenuItem } from "./menuChrome.ts";
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

export const SETTINGS_MENU_WIDGET_KEY = "persona-audit-settings";

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

/** Show the settings menu. Resolves the edited settings on Save, or undefined on Cancel/Esc. */
export function showSettingsMenu(
  ctx: ExtensionCommandContext,
  initial: PersonaAuditConfig,
): Promise<PersonaAuditConfig | undefined> {
  const draft: PersonaAuditConfig = { ...initial, meter: { ...initial.meter } };

  const items: ChoiceMenuItem[] = [
    {
      id: "meterColor",
      label: "Token activity monitor color",
      values: [...METER_COLORS],
      valueIndex: METER_COLORS.indexOf(draft.meter.color),
      compact: true,
      onChange: (index) => {
        draft.meter.color = METER_COLORS[index]!;
      },
    },
    {
      id: "meterDirection",
      label: "Token activity monitor direction",
      values: METER_DIRECTIONS.map((direction) => DIRECTION_LABELS[direction]),
      valueIndex: METER_DIRECTIONS.indexOf(draft.meter.direction),
      compact: true,
      onChange: (index) => {
        draft.meter.direction = METER_DIRECTIONS[index]!;
      },
    },
    {
      id: "temperament",
      label: "Linus Torvalds temperament",
      values: TEMPERAMENTS.map((temperament) => TEMPERAMENT_LABELS[temperament]),
      valueIndex: TEMPERAMENTS.indexOf(draft.temperament),
      compact: true,
      onChange: (index) => {
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
      onChange: (index) => {
        draft.maxVerifyRounds = index + MIN_VERIFY_ROUNDS;
      },
    },
  ];

  return showWidgetPrompt<PersonaAuditConfig | undefined>(ctx, SETTINGS_MENU_WIDGET_KEY, (tui, theme, finish) =>
    new MenuComponent(
      {
        title: "Persona-audit: Settings",
        fullWidth: true,
        sections: [{ title: "", items }],
        buttons: [
          { id: "save", label: "Save", primary: true, onSelect: () => finish({ ...draft, meter: { ...draft.meter } }) },
          { id: "cancel", label: "Cancel", onSelect: () => finish(undefined) },
        ],
      },
      theme,
      () => finish(undefined),
      tui,
    ));
}
