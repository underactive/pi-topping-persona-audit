import type { ExtensionCommandContext, Theme } from "@earendil-works/pi-coding-agent";
import { Editor, Key, matchesKey, type Component, type EditorTheme, type TUI } from "@earendil-works/pi-tui";
import { describeAdditionalContext, parseAdditionalContext, type AdditionalContext } from "../additionalContext.ts";
import type { PhaseModelSelection } from "../modelConfig.ts";
import type { AuditMode, ReviewerSelection } from "../types.ts";
import { MenuComponent, PROMPT_OVERLAY_OPTIONS, renderMenuBottomBorder, renderMenuContentRow, renderMenuSeparator, renderMenuTopBorder, showOverlayPrompt, wrapText } from "./menuChrome.ts";

export type AuditSummaryResult =
  | { action: "start"; draft: string; context: AdditionalContext }
  | { action: "back"; draft: string }
  | { action: "cancel"; draft: string };

export interface AuditSummaryConfig {
  mode: Exclude<AuditMode, "handoff">;
  fileCount: number;
  selection: ReviewerSelection;
  phaseModels: PhaseModelSelection;
  draft: string;
  cwd: string;
  reviewModelSupportsImages: boolean;
}

export class AuditSummaryComponent implements Component {
  private readonly tui: TUI;
  private readonly theme: Theme;
  private readonly config: AuditSummaryConfig;
  private readonly done: (result: AuditSummaryResult) => void;
  private readonly menu: MenuComponent;
  private readonly editor: Editor;
  private view: "summary" | "editor" = "summary";
  private draft: string;
  private context: AdditionalContext = { text: "", images: [] };
  private warnings: string[] = [];

  constructor(tui: TUI, theme: Theme, config: AuditSummaryConfig, done: (result: AuditSummaryResult) => void) {
    this.tui = tui;
    this.theme = theme;
    this.config = config;
    this.done = done;
    this.draft = config.draft;

    const editorTheme: EditorTheme = {
      borderColor: (text) => theme.fg("accent", text),
      selectList: {
        selectedPrefix: (text) => theme.fg("accent", text),
        selectedText: (text) => theme.fg("accent", text),
        description: (text) => theme.fg("muted", text),
        scrollInfo: (text) => theme.fg("dim", text),
        noMatch: (text) => theme.fg("warning", text),
      },
    };
    this.editor = new Editor(tui, editorTheme, { paddingX: 1 });
    this.editor.disableSubmit = true;
    this.editor.setText(this.draft);
    this.editor.onChange = (text) => { this.draft = text; };

    this.menu = new MenuComponent({
      title: "Persona-audit - guidance",
      fullWidth: true,
      hints: ["↑↓ item", "⇥ switch btn", "⏎ select", "esc back"],
      sections: [
        {
          title: "",
          description: "Shared only with reviewer passes. A line containing an existing PNG, JPG, JPEG, GIF, or WebP path attaches that image to every reviewer pass.",
          items: [{ id: "context", label: "Additional context", displayValue: "(none)", onSelect: () => this.openEditor() }],
        },
      ],
      buttons: [
        { id: "start", label: "Start audit", primary: true, onSelect: () => { void this.start(); } },
        { id: "back", label: "Back", onSelect: () => this.done({ action: "back", draft: this.draft }) },
        { id: "cancel", label: "Cancel", onSelect: () => this.done({ action: "cancel", draft: this.draft }) },
      ],
    }, theme, () => this.done({ action: "back", draft: this.draft }), tui);
    void this.refreshContext();
  }

  private openEditor(): void {
    this.editor.setText(this.draft);
    this.view = "editor";
    this.tui.requestRender();
  }

  private async closeEditor(): Promise<void> {
    this.draft = this.editor.getExpandedText();
    await this.refreshContext();
    this.view = "summary";
    this.tui.requestRender();
  }

  private async refreshContext(): Promise<void> {
    const parsed = await parseAdditionalContext(this.draft, this.config.cwd);
    this.context = parsed.context;
    this.warnings = parsed.warnings;
    if (this.context.images.length > 0 && !this.config.reviewModelSupportsImages) {
      this.warnings.push("The selected review model does not declare image input support; choose an image-capable model or remove the attachments.");
    }
    this.menu.setItemValue("context", describeAdditionalContext(this.context));
  }

  private async start(): Promise<void> {
    await this.refreshContext();
    if (this.context.images.length > 0 && !this.config.reviewModelSupportsImages) {
      this.tui.requestRender();
      return;
    }
    this.done({ action: "start", draft: this.draft, context: this.context });
  }

  handleInput(data: string): void {
    if (this.view === "summary") {
      this.menu.handleInput(data);
      return;
    }
    if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("s"))) {
      void this.closeEditor();
      return;
    }
    this.editor.handleInput(data);
    this.tui.requestRender();
  }

  private renderSummary(width: number): string[] {
    const lines = this.menu.render(width);
    if (this.warnings.length === 0) return lines;
    const insertAt = Math.max(1, lines.length - 2);
    const warningLines = this.warnings.flatMap((warning) => wrapText(`Warning: ${warning}`, Math.max(10, width - 4)))
      .map((line) => renderMenuContentRow(this.theme, width, this.theme.fg("warning", `  ${line}`)));
    return [...lines.slice(0, insertAt), ...warningLines, ...lines.slice(insertAt)];
  }

  private renderEditor(width: number): string[] {
    const innerWidth = Math.max(20, width);
    const bodyWidth = Math.max(10, innerWidth - 2);
    return [
      renderMenuTopBorder(this.theme, innerWidth, "Additional reviewer context"),
      ...wrapText("Enter shared review guidance. Put one existing image path on its own line to attach it. Press Esc or Ctrl+S to save and return.", bodyWidth)
        .map((line) => renderMenuContentRow(this.theme, innerWidth, this.theme.fg("muted", ` ${line}`))),
      renderMenuSeparator(this.theme, innerWidth),
      ...this.editor.render(bodyWidth).map((line) => renderMenuContentRow(this.theme, innerWidth, ` ${line}`)),
      renderMenuSeparator(this.theme, innerWidth),
      renderMenuContentRow(this.theme, innerWidth, this.theme.fg("dim", "  esc/ctrl+s save and return")),
      renderMenuBottomBorder(this.theme, innerWidth),
    ];
  }

  private padBeforeBottomBorder(lines: string[], targetHeight: number, width: number): string[] {
    const missing = targetHeight - lines.length;
    const bottomBorder = lines[lines.length - 1];
    if (missing <= 0 || bottomBorder === undefined) return lines;
    return [
      ...lines.slice(0, -1),
      ...Array.from({ length: missing }, () => renderMenuContentRow(this.theme, width, "")),
      bottomBorder,
    ];
  }

  render(width: number): string[] {
    const summaryLines = this.renderSummary(width);
    const editorLines = this.renderEditor(width);
    const targetHeight = Math.max(summaryLines.length, editorLines.length);
    return this.view === "summary"
      ? this.padBeforeBottomBorder(summaryLines, targetHeight, width)
      : this.padBeforeBottomBorder(editorLines, targetHeight, Math.max(20, width));
  }

  invalidate(): void {
    this.menu.invalidate();
    this.editor.invalidate();
  }
}

export function showAuditSummary(ctx: ExtensionCommandContext, config: Omit<AuditSummaryConfig, "cwd">): Promise<AuditSummaryResult> {
  return showOverlayPrompt(
    ctx,
    (tui, theme, done) => new AuditSummaryComponent(tui, theme, { ...config, cwd: ctx.cwd }, done),
    PROMPT_OVERLAY_OPTIONS,
  );
}
