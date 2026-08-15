/**
 * Persisted /persona-audit settings: per-phase model + thinking (ported from
 * pi-moa-plan's `src/moaConfig.ts`), the progress table's activity-meter
 * appearance, and the Linus Torvalds reviewer's register.
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getAgentDir, type ThemeColor } from "@earendil-works/pi-coding-agent";

export interface ModelRef {
  provider: string;
  id: string;
}

/**
 * pi's thinking-level vocabulary, in pi's canonical order (see
 * `pi.getThinkingLevel()` / `--thinking <level>`). `xhigh` and `max` are
 * distinct levels a model may expose independently, so neither is folded
 * into the other.
 */
export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type ThinkingLevel = (typeof THINKING_LEVELS)[number];

export function isThinkingLevel(value: string): value is ThinkingLevel {
  return (THINKING_LEVELS as readonly string[]).includes(value);
}

/** The four audit phases a model + thinking level can be assigned to. */
export const PHASE_SLOTS = ["review", "triage", "implement", "verify"] as const;
export type PhaseSlot = (typeof PHASE_SLOTS)[number];

export interface PhaseModelChoice {
  ref: ModelRef;
  thinking: ThinkingLevel;
}

export type PhaseModelSelection = Record<PhaseSlot, PhaseModelChoice>;

/** Meter cell colours, matching pi-topping's option list. `satisfies` proves each names a real theme colour. */
export const METER_COLORS = ["accent", "border", "borderAccent", "success", "error", "warning"] as const satisfies readonly ThemeColor[];
export type MeterColor = (typeof METER_COLORS)[number];

export const METER_DIRECTIONS = ["ltr", "rtl"] as const;
export type MeterDirection = (typeof METER_DIRECTIONS)[number];

/** Appearance of the progress table's activity meter, set in `/persona-audit-settings`. */
export interface MeterSettings {
  color: MeterColor;
  direction: MeterDirection;
}

/** The appearance the table used before it became configurable. */
export const DEFAULT_METER_SETTINGS: MeterSettings = { color: "accent", direction: "rtl" };

/**
 * Register levels for the Linus Torvalds reviewer, ordered coolest first.
 * Changes the persona's tone only — lenses, focus areas, and severity grading
 * are identical at every level. See `docs/temperament.md`.
 */
export const TEMPERAMENTS = ["calibrated", "caustic", "lkml"] as const;
export type Temperament = (typeof TEMPERAMENTS)[number];

export const DEFAULT_TEMPERAMENT: Temperament = "calibrated";

/**
 * Bounds for the fix→verify round cap set in `/persona-audit-settings`. Round 1
 * is the original implement + verify pass; the rest are automatic gate-repair
 * rounds. `MIN_VERIFY_ROUNDS` of 1 means round 1 only — auto-repair off. The
 * ceiling is generous because the repair loop's stagnation guard already stops
 * a run that stops converging, so the cap only bites on genuinely slow progress.
 */
export const MIN_VERIFY_ROUNDS = 1;
export const MAX_VERIFY_ROUNDS = 10;
export const DEFAULT_VERIFY_ROUNDS = 3;

export interface PersonaAuditConfig {
  phases: Partial<PhaseModelSelection>;
  /** Last thinking level chosen for a model in the picker, keyed by `modelRefLabel(ref)`. */
  thinkingOverrides: Record<string, ThinkingLevel>;
  meter: MeterSettings;
  temperament: Temperament;
  /** Total fix→verify rounds allowed, clamped to [MIN_VERIFY_ROUNDS, MAX_VERIFY_ROUNDS]. */
  maxVerifyRounds: number;
}

function emptyConfig(): PersonaAuditConfig {
  return {
    phases: {},
    thinkingOverrides: {},
    meter: { ...DEFAULT_METER_SETTINGS },
    temperament: DEFAULT_TEMPERAMENT,
    maxVerifyRounds: DEFAULT_VERIFY_ROUNDS,
  };
}

/** Clamp any stored value to a whole number of rounds within bounds, or the default. */
export function clampVerifyRounds(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return DEFAULT_VERIFY_ROUNDS;
  return Math.min(MAX_VERIFY_ROUNDS, Math.max(MIN_VERIFY_ROUNDS, Math.round(value)));
}

/** Persistent persona-audit settings, colocated with pi's user-level settings. */
export function personaAuditSettingsPath(): string {
  return join(getAgentDir(), "persona-audit", "settings.json");
}

function isModelRef(value: unknown): value is ModelRef {
  return !!value
    && typeof value === "object"
    && typeof (value as ModelRef).provider === "string"
    && typeof (value as ModelRef).id === "string";
}

function isMeterColor(value: unknown): value is MeterColor {
  return (METER_COLORS as readonly unknown[]).includes(value);
}

function isMeterDirection(value: unknown): value is MeterDirection {
  return (METER_DIRECTIONS as readonly unknown[]).includes(value);
}

function isTemperament(value: unknown): value is Temperament {
  return (TEMPERAMENTS as readonly unknown[]).includes(value);
}

function isPhaseModelChoice(value: unknown): value is PhaseModelChoice {
  return !!value
    && typeof value === "object"
    && isModelRef((value as PhaseModelChoice).ref)
    && typeof (value as PhaseModelChoice).thinking === "string"
    && isThinkingLevel((value as PhaseModelChoice).thinking);
}

/** Pure parser over a settings file's raw contents — no I/O, so tests need none. */
export function parsePersonaAuditSettings(raw: string): PersonaAuditConfig {
  try {
    const parsed = JSON.parse(raw) as Partial<PersonaAuditConfig>;

    const phases: Partial<PhaseModelSelection> = {};
    if (parsed.phases && typeof parsed.phases === "object") {
      for (const slot of PHASE_SLOTS) {
        const choice = (parsed.phases as Record<string, unknown>)[slot];
        if (isPhaseModelChoice(choice)) phases[slot] = choice;
      }
    }

    const thinkingOverrides: Record<string, ThinkingLevel> = {};
    if (parsed.thinkingOverrides && typeof parsed.thinkingOverrides === "object") {
      for (const [key, value] of Object.entries(parsed.thinkingOverrides)) {
        if (typeof value === "string" && isThinkingLevel(value)) thinkingOverrides[key] = value;
      }
    }

    const meter = { ...DEFAULT_METER_SETTINGS };
    if (parsed.meter && typeof parsed.meter === "object") {
      const { color, direction } = parsed.meter as Partial<MeterSettings>;
      if (isMeterColor(color)) meter.color = color;
      if (isMeterDirection(direction)) meter.direction = direction;
    }

    const temperament = isTemperament(parsed.temperament) ? parsed.temperament : DEFAULT_TEMPERAMENT;
    const maxVerifyRounds = clampVerifyRounds(parsed.maxVerifyRounds);

    return { phases, thinkingOverrides, meter, temperament, maxVerifyRounds };
  } catch {
    return emptyConfig();
  }
}

export function loadPersonaAuditConfig(): PersonaAuditConfig {
  try {
    return parsePersonaAuditSettings(readFileSync(personaAuditSettingsPath(), "utf-8"));
  } catch {
    return emptyConfig();
  }
}

export function savePersonaAuditConfig(config: PersonaAuditConfig): void {
  const path = personaAuditSettingsPath();
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(config, null, "\t")}\n`, "utf-8");
  renameSync(tmp, path);
}


/**
 * The levels to offer for a model, in pi's canonical thinking-level order.
 * The registry's declared range is the whole answer — a level it does not list
 * is one the backend will refuse.
 */
export function thinkingOptionsForModel(registryLevels: ThinkingLevel[]): ThinkingLevel[] {
  return THINKING_LEVELS.filter((level) => registryLevels.includes(level));
}

/** Selects a model's saved level, the current level, or a sensible default in that order. */
export function defaultThinkingForModel(
  key: string,
  thinkingOverrides: Record<string, ThinkingLevel>,
  currentLevel: ThinkingLevel,
  registryLevels: ThinkingLevel[],
): ThinkingLevel {
  const options = thinkingOptionsForModel(registryLevels);
  const saved = thinkingOverrides[key];
  if (saved && options.includes(saved)) return saved;
  if (options.includes(currentLevel)) return currentLevel;
  if (options.includes("medium")) return "medium";
  return options[0] ?? "medium";
}

export function modelRefLabel(ref: ModelRef): string {
  return `${ref.provider}/${ref.id}`;
}

export function phaseModelChoiceLabel(choice: PhaseModelChoice): string {
  return `${modelRefLabel(choice.ref)} (thinking: ${choice.thinking})`;
}
