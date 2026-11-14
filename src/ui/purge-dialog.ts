/**
 * Adapter between the artifact scan and the generated `/persona-audit-purge` dialog.
 *
 * Hand-written. The dialog itself is `./generated/persona-audit/admin.ts` (`PurgeMenu`: tagging,
 * the preview viewer and the confirmation are all inside it), converted from the mockup in
 * `../opentui-dialogs`. This file translates the entries in and the confirmed ones out.
 */
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { showOpenTuiDialog } from "@underactive/pi-topping-opentui/host";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import * as path from "node:path";
import { createElement } from "react";
import { formatAge, formatBytes, type ArtifactEntry } from "../artifacts.ts";
import { DIALOG_MAX_HEIGHT, PURGE_DIALOG_SIZE, type TerminalSize } from "./dialog-fit.ts";
import { PurgeMenu, type PurgeResult } from "./generated/persona-audit/admin.ts";
import type { Artifact } from "./generated/persona-audit/data.ts";

/** Reported to pi as the question the session is blocked on, as the pi-tui menu does. */
export const PURGE_DIALOG_TITLE = "Persona-audit: Purge artifacts";

/** The directory with the home directory written as `~`. */
export function displayDirectory(absPath: string): string {
  const directory = path.dirname(absPath);
  const home = homedir();
  return directory === home ? "~" : directory.startsWith(`${home}${path.sep}`) ? `~${directory.slice(home.length)}` : directory;
}

/** The scan's entries in the dialog's shape. `tagged` is what starts ticked: only `preTagged` entries, and never a cache entry. */
export function toDialogArtifacts(entries: readonly ArtifactEntry[], preTagged: ReadonlySet<string>): Artifact[] {
  return entries.map((entry) => ({
    id: entry.id,
    kind: entry.kind,
    displayPath: entry.displayPath,
    dir: displayDirectory(entry.absPath),
    size: formatBytes(entry.sizeBytes),
    bytes: entry.sizeBytes,
    age: formatAge(entry.mtimeMs),
    tagged: preTagged.has(entry.id),
    ...(entry.detail ? { detail: entry.detail } : {}),
  }));
}

/**
 * The text the preview shows: a `.json` artifact pretty-printed (the dialog fences it as JSON),
 * anything else as it is. Rejects with the reason when the file cannot be read; the dialog shows it.
 */
export function previewLoader(entries: readonly ArtifactEntry[]): (artifact: Artifact) => Promise<string> {
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  return async (artifact) => {
    const entry = byId.get(artifact.id);
    if (!entry) throw new Error("the artifact is no longer listed");
    const raw = await readFile(entry.absPath, "utf-8");
    return entry.absPath.endsWith(".json") ? JSON.stringify(JSON.parse(raw), null, 2) : raw;
  };
}

/**
 * Show the generated purge dialog. Resolves with the entries the user confirmed deleting, or `null`
 * when they cancelled or the dialog closed with nothing to delete. Resolves with `undefined` when
 * the dialog failed; the failure has been reported by then, so the command handler never sees it
 * thrown. The caller deletes: the confirmation was the dialog's own.
 */
export async function openPurgeDialog(
  ctx: ExtensionCommandContext,
  entries: readonly ArtifactEntry[],
  preTagged: ReadonlySet<string>,
  terminal: TerminalSize,
): Promise<ArtifactEntry[] | null | undefined> {
  try {
    const result = await showOpenTuiDialog<PurgeResult>(
      ctx,
      (done) => createElement(PurgeMenu, {
        width: PURGE_DIALOG_SIZE.columns,
        height: Math.max(PURGE_DIALOG_SIZE.rows - 6, terminal.rows - 6),
        artifacts: toDialogArtifacts(entries, preTagged),
        loadPreview: previewLoader(entries),
        notify: (message, kind) => ctx.ui.notify(message, kind),
        onDone: done,
      }),
      { title: PURGE_DIALOG_TITLE, width: PURGE_DIALOG_SIZE.columns, maxHeight: DIALOG_MAX_HEIGHT, fallback: null },
    );
    if (!result) return null;
    const ids = new Set(result.deleted.map((artifact) => artifact.id));
    const confirmed = entries.filter((entry) => ids.has(entry.id));
    return confirmed.length > 0 ? confirmed : null;
  } catch (error) {
    ctx.ui.notify(`Persona-audit purge dialog failed: ${error instanceof Error ? error.message : String(error)}`, "error");
    return undefined;
  }
}
