// SPDX-License-Identifier: MIT
// Multiple Choice (single-part, four options, exactly one correct). Used by Central Ideas (T9)
// "Which sentence best shows the main idea?" items. 1 point for the correct option.
import { useState } from "react";
import { OptionRow, StemLine, ResultBanner, analysisIndex, type Mode } from "./itemKit";

export function MultipleChoiceItem({
  item,
  mode,
  respond,
}: {
  item: any;
  mode: Mode;
  respond: (r: any) => void;
}) {
  const [picked, setPicked] = useState<string | undefined>();
  const ax = analysisIndex(item);
  const preview = mode === "preview";
  const options: any[] = item.choice?.options ?? [];
  const ok = !!options.find((o: any) => o.key === picked)?.correct;

  const choose = (key: string) => {
    setPicked(key);
    respond({ choice: key });
  };

  return (
    <div className="flex flex-col gap-2">
      <StemLine>{item.stem?.partA}</StemLine>
      {options.map((o: any) => (
        <OptionRow
          key={o.key}
          name={`${item.id}-mc`}
          optKey={o.key}
          selected={picked === o.key}
          onSelect={() => choose(o.key)}
          mode={mode}
          correct={o.correct}
          analysis={ax[`A:${o.key}`]}
          feedback={preview && picked !== undefined}
        >
          {o.text}
        </OptionRow>
      ))}
      {preview && picked !== undefined && (
        <ResultBanner correct={ok}>
          {ok ? "Correct — 1 / 1 point." : "Not quite — 0 / 1 point."}
        </ResultBanner>
      )}
    </div>
  );
}
