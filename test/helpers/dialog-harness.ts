/**
 * Test support for the generated OpenTUI dialogs: a stand-in for pi's `ctx.ui.custom`, and
 * helpers that send a key and wait for React to finish with it.
 *
 * Not a test file. The `tests/*.test.ts` glob does not run it.
 */
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { TerminalSize } from "../../src/ui/dialog-fit.ts";

export type Notification = { message: string; type?: string };
export interface ShownComponent {
  render(width: number): readonly string[];
  handleInput?(data: string): void;
  dispose?(): void;
}
type CustomFactory<T> = (tui: unknown, theme: unknown, keybindings: unknown, done: (result: T) => void) => ShownComponent | Promise<ShownComponent>;

/** The bytes pi-tui hands a component for each key, already split into one sequence per key. */
export const KEY = {
  up: "\x1b[A",
  down: "\x1b[B",
  right: "\x1b[C",
  left: "\x1b[D",
  end: "\x1b[F",
  enter: "\r",
  backspace: "\x7f",
  esc: "\x1b",
  space: " ",
  tab: "\t",
  ctrlS: "\x13",
} as const;

/** A terminal with room for every dialog at its full 104-column size. */
export const ROOMY_TERMINAL: TerminalSize = { columns: 120, rows: 40 };

const turn = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

export function stripAnsi(text: string): string {
  return text.replace(/\x1b\[[0-9;]*m/g, "");
}

/** The frame as plain text. */
export function screen(component: ShownComponent, width = 100): string {
  return component.render(width).map(stripAnsi).join("\n");
}

/**
 * Wait until the frame has not changed across two turns of the event loop. A key handler only
 * sets state; React commits it a moment later, and the next key must see that commit.
 */
export async function settle(component: ShownComponent, width = 100): Promise<void> {
  const deadline = Date.now() + 2000;
  let previous = component.render(width).join("\n");
  for (let quiet = 0; quiet < 2;) {
    if (Date.now() >= deadline) throw new Error("dialog did not settle within 2 seconds");
    await turn();
    const current = component.render(width).join("\n");
    quiet = current === previous ? quiet + 1 : 0;
    previous = current;
  }
}

/** Send keys one at a time, letting the dialog settle after each. */
export async function press(component: ShownComponent, ...keys: string[]): Promise<void> {
  for (const key of keys) {
    component.handleInput?.(key);
    try {
      await settle(component);
    } catch (error) {
      throw new Error(`dialog did not settle after key ${JSON.stringify(key)}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

/** Fail a test with context instead of leaving it hung on a dialog that never called done(). */
export async function waitForResult<T>(result: Promise<T>, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      result,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`timed out waiting for ${what}`)), 2000);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** Poll once per turn of the event loop until `read` returns something, for about two seconds. */
export async function waitFor<T>(read: () => T | undefined | false, what: string): Promise<T> {
  const deadline = Date.now() + 2000;
  for (;;) {
    const value = read();
    if (value !== undefined && value !== false) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await turn();
  }
}

export interface DialogHost {
  ctx: ExtensionCommandContext;
  notifications: Notification[];
  /** Every component pi would have put on screen, oldest first. */
  shown: ShownComponent[];
  /** The options each `ctx.ui.custom` call was given. */
  customOptions: unknown[];
  /** The component on screen, once there is one. */
  dialog(): Promise<ShownComponent>;
}

/**
 * A command context whose `ui.custom` behaves like pi's `showExtensionCustom()`: the factory
 * gets a TUI with the given terminal, a component whose factory already finished the dialog is
 * dropped without being shown, and `done()` disposes the component that was shown.
 * Without `terminal` the TUI reports no size; the dialog runtime then assumes 24 rows.
 */
export function createDialogHost(options: {
  terminal?: TerminalSize;
  mode?: string;
  thinkingLevel?: string;
  failCustom?: Error;
  /** Models the registry offers, as pi reports them. */
  models?: { provider: string; id: string; reasoning: boolean }[];
  /** The session's model. */
  model?: { provider: string; id: string };
  cwd?: string;
} = {}): DialogHost {
  const notifications: Notification[] = [];
  const shown: ShownComponent[] = [];
  const customOptions: unknown[] = [];
  const tui = { requestRender: () => {}, ...(options.terminal ? { terminal: options.terminal } : {}) };
  // The two members `resolveTheme` requires; with no colours every token paints as the terminal default.
  const theme = { colors: {}, getColorMode: () => "truecolor" };
  const ctx = {
    hasUI: true,
    cwd: options.cwd ?? process.cwd(),
    mode: options.mode ?? "tui",
    thinkingLevel: options.thinkingLevel,
    ...(options.model ? { model: options.model } : {}),
    modelRegistry: {
      getAvailable: () => options.models ?? [],
      find: (provider: string, id: string) => (options.models ?? []).find((m) => m.provider === provider && m.id === id),
    },
    ui: {
      theme,
      notify(message: string, type?: string) {
        notifications.push({ message, type });
      },
      custom<T>(factory: CustomFactory<T>, given?: unknown): Promise<T> {
        customOptions.push(given);
        if (options.failCustom) return Promise.reject(options.failCustom);
        return new Promise<T>((resolve, reject) => {
          let component: ShownComponent | undefined;
          let closed = false;
          const close = (result: T): void => {
            if (closed) return;
            closed = true;
            component?.dispose?.();
            resolve(result);
          };
          Promise.resolve(factory(tui, theme, {}, close)).then((produced) => {
            if (closed) return;
            component = produced;
            shown.push(produced);
          }, reject);
        });
      },
    },
  } as unknown as ExtensionCommandContext;
  return {
    ctx,
    notifications,
    shown,
    customOptions,
    dialog: () => waitFor(() => shown.at(-1), "a dialog to be shown"),
  };
}
