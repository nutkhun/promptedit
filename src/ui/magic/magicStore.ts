// Magic's UI state: the popover, the prompt being typed (kept while the popover is closed, cleared
// when sent), the tab and the model/effort picks (remembered), and the backend's run state as polled.

import { create } from "zustand";
import { magicApi, type AiKind, type Availability, type MagicState, type ModelOption, type Tab } from "./magicApi";

const KEY = "promptedit.magic";

interface Prefs {
  tab: Tab;
  model: Partial<Record<AiKind, string>>;
  effort: Partial<Record<AiKind, string>>;
}

function loadPrefs(): Prefs {
  try {
    return { tab: "claude", model: {}, effort: {}, ...JSON.parse(localStorage.getItem(KEY) ?? "{}") };
  } catch {
    return { tab: "claude", model: {}, effort: {} };
  }
}

interface MagicUI extends Prefs {
  open: boolean;
  prompt: string;
  run: MagicState;
  availability?: Record<AiKind, Availability>;
  models: Partial<Record<AiKind, ModelOption[]>>;
  /** What the Local tab says about its reader (no local model). */
  localNote?: string | null;
  localModel?: string | null;
  set: (s: Partial<MagicUI>) => void;
  setTab: (t: Tab) => void;
  setModel: (k: AiKind, model: string, effort: string) => void;
  refresh: () => Promise<void>;
  poll: () => Promise<MagicState | undefined>;
}

const save = (p: Prefs) => {
  try {
    localStorage.setItem(KEY, JSON.stringify({ tab: p.tab, model: p.model, effort: p.effort }));
  } catch { /* private mode */ }
};

export const useMagic = create<MagicUI>((set, get) => ({
  ...loadPrefs(),
  open: false,
  prompt: "",
  run: { running: false, seconds: 0 },
  models: {},
  set: (s) => set(s),
  setTab: (tab) => {
    set({ tab });
    save(get());
  },
  setModel: (k, model, effort) => {
    set({ model: { ...get().model, [k]: model }, effort: { ...get().effort, [k]: effort } });
    save(get());
  },
  /** What's connected and installed, the model lists and the Local reader (on opening the popover). */
  refresh: async () => {
    const [availability, claude, chatgpt, local] = await Promise.all([
      magicApi.availability().catch(() => undefined),
      magicApi.models("claude").catch(() => []),
      magicApi.models("chatgpt").catch(() => []),
      magicApi.localStatus().catch(() => undefined),
    ]);
    set({ availability, models: { claude, chatgpt }, localNote: local?.note ?? null, localModel: local?.model ?? null });
  },
  poll: async () => {
    try {
      const run = await magicApi.state();
      set({ run });
      return run;
    } catch {
      return undefined;
    }
  },
}));

/** The chosen model: the one picked last time if it's still offered, or the first. */
export function chosenModel(k: AiKind): ModelOption | undefined {
  const s = useMagic.getState();
  const list = s.models[k] ?? [];
  return list.find((m) => m.id === s.model[k]) ?? list[0];
}

export function chosenEffort(k: AiKind): string {
  const m = chosenModel(k);
  const saved = useMagic.getState().effort[k];
  if (m && saved && m.efforts.includes(saved)) return saved;
  return m?.defaultEffort ?? "";
}
