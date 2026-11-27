// Settings › General › Captions: which speech model listens (Fast / Balanced / Best) and in which
// language (docs/spec/05-captions-contract.md "Speech models"). Read from and saved to the backend.

import { useEffect, useState } from "react";
import { Segmented } from "../ui/buttons";
import { MenuField } from "../ui/controls";
import { transcriptionSettingsGet, transcriptionSettingsSet, type SpeechModelId, type TranscriptionSettings } from "../transcripts";
import { formatSize } from "./speechModel";
import { refreshModel, useTranscripts } from "./store";

/** Auto, then the languages people most often caption in (whisper's ISO 639-1 codes). */
export const LANGUAGES: [string, string][] = [
  ["auto", "Auto"],
  ["en", "English"], ["th", "Thai (ไทย)"], ["ja", "Japanese (日本語)"], ["zh", "Chinese (中文)"], ["ko", "Korean (한국어)"],
  ["es", "Spanish (Español)"], ["fr", "French (Français)"], ["de", "German (Deutsch)"], ["pt", "Portuguese (Português)"],
  ["vi", "Vietnamese (Tiếng Việt)"], ["id", "Indonesian (Bahasa Indonesia)"], ["it", "Italian (Italiano)"],
  ["nl", "Dutch (Nederlands)"], ["ru", "Russian (Русский)"], ["uk", "Ukrainian (Українська)"], ["pl", "Polish (Polski)"],
  ["tr", "Turkish (Türkçe)"], ["ar", "Arabic (العربية)"], ["hi", "Hindi (हिन्दी)"], ["ms", "Malay (Bahasa Melayu)"],
  ["tl", "Filipino (Tagalog)"], ["sv", "Swedish (Svenska)"],
];
const SHORT: Record<SpeechModelId, string> = { fast: "Fast", balanced: "Balanced", best: "Best" };

type Row = ({ title, detail, children }: { title: string; detail?: string; children: React.ReactNode }) => React.ReactElement;

/** The Captions section's rows, laid out with the settings page's own row (passed in). */
export function CaptionSettingsRows({ Row }: { Row: Row }) {
  const [settings, setSettings] = useState<TranscriptionSettings>();
  const [error, setError] = useState<string>();
  const model = useTranscripts((s) => s.model);

  useEffect(() => {
    let live = true;
    transcriptionSettingsGet().then((s) => { if (live) setSettings(s); }).catch((e) => { if (live) setError(String(e)); });
    void refreshModel();
    return () => { live = false; };
    // Downloaded models change when a download finishes.
  }, [model?.state]);

  const change = async (c: { model?: SpeechModelId; language?: string }) => {
    try {
      setSettings(await transcriptionSettingsSet(c));
      void refreshModel();
    } catch (e) {
      setError(String(e));
    }
  };

  if (!settings) {
    return (
      <Row title="Speech" detail={error ? "Listening for what's said isn't available in this build." : "…"}>
        <span />
      </Row>
    );
  }
  const chosen = settings.models.find((m) => m.id === settings.model);
  const status = model?.state === "downloading"
    ? `Downloading… ${Math.floor(model.progress * 100)}%`
    : chosen?.downloaded ? "Downloaded" : chosen ? `Downloads when you first add captions (${formatSize(chosen.sizeMB)})` : "";
  const language = LANGUAGES.find(([code]) => code === settings.language)?.[1] ?? settings.language;
  return (
    <>
      <Row title="Speech model" detail={`${chosen?.label ?? ""}${status ? ` · ${status}` : ""}. Captions are heard on this computer; nothing is sent anywhere.`}>
        <Segmented
          options={settings.models.map((m) => [m.id, SHORT[m.id] ?? m.label] as [SpeechModelId, string])}
          value={settings.model}
          onChange={(v) => void change({ model: v })}
        />
      </Row>
      <div className="pe-settings-divider" />
      <Row title="Language" detail="What's said in your clips. Auto works it out for each file.">
        <div className="pe-caption-language">
          <MenuField label={language} items={LANGUAGES.map(([code, name]) => ({
            label: name, checked: code === settings.language, onSelect: () => void change({ language: code }),
          }))} />
        </div>
      </Row>
    </>
  );
}
