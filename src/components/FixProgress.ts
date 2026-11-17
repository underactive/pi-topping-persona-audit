/**
 * Fix Now surfaces, split by lifecycle responsibility. Working and settling
 * status lives in the audit table as nested detail under the `fix now · …`
 * row (via the sink below) — it is not a prompt, so Pi must not bracket it as
 * a user wait. Each accept/retry/discard decision opens one fresh overlay, the
 * generated `FixGate` dialog (`../ui/review-dialogs.ts`), through ctx.ui.custom
 * — the only lifecycle prompt here. The gate calls done the moment the user
 * decides, ending the prompt span before retry/discard cleanup, commit
 * summarization, or commit work begins.
 */

import { isKeyRelease, Key, matchesKey } from "@earendil-works/pi-tui";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AuditProgressWidget } from "./AuditProgress.ts";
import type { Finding, HeadlessProgress } from "../types.ts";
import { openFixGateDialog } from "../ui/review-dialogs.ts";

export interface FixChatMessage {
  role: "user" | "assistant";
  text: string;
}

export type FixGateDecision = "accept" | "retry" | "discard" | { type: "chat"; message: string };

/** What the fix flow feeds into the gate view. */
export interface FixGateInput {
  diff: string;
  /** Verifier verdict line, shown above the diff. */
  verdictNote?: string;
  /** Degradations (verifier failed, dirty files kept, …), shown as warnings. */
  warnings?: string[];
  /** False when the user opted out of auto-commit — the accept key relabels accordingly. */
  commitPlanned: boolean;
  /** Attempt number, 1-based. */
  attempt: number;
  /** Prior conversation history within this attempt. */
  chatHistory?: FixChatMessage[];
}

// ── Controller ─────────────────────────────────────────────────────────────

/** Handle the fix flow drives for the life of one fix episode. */
export interface FixProgressController {
  setPhase(phase: "fixing" | "verifying", statusText: string, attempt: number): void;
  applyProgress(progress: HeadlessProgress): void;
  gate(input: FixGateInput): Promise<FixGateDecision>;
  /** Settle any open gate as discard, remove the listener and row detail. Idempotent. */
  close(): Promise<void>;
}

/**
 * The slice of pi's extension `ui` openFixProgress needs: one raw input
 * listener for the double-Escape cancel gesture and focused custom overlays
 * for the decision gates. The context carrying it says which mode pi runs in,
 * since the gate needs TUI mode.
 */
export type FixProgressUi = Pick<ExtensionContext["ui"], "onTerminalInput" | "custom"> & Partial<Pick<ExtensionContext["ui"], "notify">>;

/** Where working/settling status goes: nested detail on the audit table's fix-now row. */
export interface FixProgressSink {
  key: string;
  progress: AuditProgressWidget;
}

/**
 * Open a Fix Now episode and return the controller the flow drives. There is
 * no separate widget: the audit table row named by `sink` carries the
 * telemetry (via applyProgress) and the nested working/settling detail, so
 * custom() — and therefore a prompt lifecycle span — happens only inside
 * gate(). Pi owns focus, disposal, keyboard dispatch, and Kitty key-release
 * filtering for the gate overlay; the raw working listener below is
 * unfocused, so it keeps its own release guard.
 */
export function openFixProgress(
  ctx: { mode: ExtensionContext["mode"]; ui: FixProgressUi },
  finding: Finding,
  onCancelRequest: () => void,
  sink?: FixProgressSink,
): FixProgressController {
  let closed = false;
  /** True while a gate overlay owns keyboard focus. */
  let gateActive = false;
  /** True once a decision is handed back — the follow-up file work is inert to input. */
  let settling = false;
  let cancelArmed = false;
  /** The open gate's done callback — lets close() settle it as discard. */
  let settleGate: ((decision: FixGateDecision) => void) | undefined;

  sink?.progress.setFixNowDetail(sink.key, finding);
  /** Band highlight before the episode — restored on close so the surface that opened the fix (typically the Triage-parked review overlay) gets its phase back. */
  const previousPhase = sink?.progress.activePhase();

  const setArmed = (armed: boolean): void => {
    if (cancelArmed === armed) return;
    cancelArmed = armed;
    sink?.progress.setFixNowCancelArmed(sink.key, armed);
  };

  // Raw, unfocused listener for the working surface. It consumes only Escape
  // (the double-press cancel gesture) and swallows Kitty release events so one
  // physical keypress cannot arm-and-cancel in a single motion. Everything
  // else passes through to the editor/host untouched — and disarms a pending
  // cancel confirmation on its way. While a gate overlay is open, input is
  // left alone: the focused overlay owns it.
  const unsubscribe = ctx.ui.onTerminalInput((data) => {
    if (closed || gateActive) return undefined;
    if (isKeyRelease(data)) return { consume: true };
    if (!matchesKey(data, Key.escape)) {
      if (cancelArmed) setArmed(false);
      return undefined;
    }
    // A decision is already with the flow; keep Escape inert while its
    // follow-up file operation finishes.
    if (settling) return { consume: true };
    if (!cancelArmed) {
      setArmed(true);
      return { consume: true };
    }
    setArmed(false);
    onCancelRequest();
    return { consume: true };
  });

  return {
    setPhase: (phase, statusText, attempt) => {
      if (closed) return;
      settling = false;
      setArmed(false);
      // The band highlight follows the fix-now progress: edit-capable work is
      // the Implement phase, the single-finding verifier pass is Verify.
      sink?.progress.setActivePhase(phase === "fixing" ? "Implement" : "Verify");
      sink?.progress.updateFixNowPhase(sink.key, phase, statusText, attempt);
    },
    applyProgress: (progress) => {
      if (closed) return;
      sink?.progress.applyProgress(sink.key, progress);
    },
    gate: async (input) => {
      if (closed) return "discard";
      gateActive = true;
      // Outside TUI mode the dialog resolves with its fallback at once, and a gate that fails to
      // open (it has said why) settles the same way: an unreviewed fix is never kept.
      const shown = openFixGateDialog(
        { mode: ctx.mode, ui: ctx.ui },
        finding,
        input,
        (settle) => { settleGate = settle; },
        (error) => ctx.ui.notify?.(`Persona-audit Fix Now gate dialog failed: ${error instanceof Error ? error.message : String(error)}`, "error"),
      ).then((decision) => decision ?? "discard");
      return shown
        .then((decision) => {
          if (!closed) {
            if (typeof decision === "string") {
              settling = true;
              setArmed(false);
              sink?.progress.updateFixNowSettling(sink.key, decision, input.commitPlanned);
            }
          }
          return decision;
        })
        .finally(() => {
          gateActive = false;
          settleGate = undefined;
        });
    },
    close: async () => {
      if (closed) return;
      closed = true;
      // Settle any still-open gate as discard so its overlay resolves instead
      // of leaking; the flow treats it as an ordinary discard decision.
      settleGate?.("discard");
      settleGate = undefined;
      unsubscribe();
      sink?.progress.setActivePhase(previousPhase);
      sink?.progress.clearFixNowDetail(sink.key);
    },
  };
}
