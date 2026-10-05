// SPDX-License-Identifier: MIT
// EBSR (Task Model 1): two-part evidence-based selected response. Part A = inference
// statement (4 options); Part B = supporting line (4 options). Both correct = 1 point.
import { useState } from "react";
import { OptionRow, StemLine, ResultBanner, analysisIndex, type Mode } from "./itemKit";

export function EbsrItem({
  item,
  mode,
  respond,
}: {
  item: any;
  mode: Mode;
  respond: (r: any) => void;
}) {
  const [partA, setPartA] = useState<string | undefined>();
  const [partB, setPartB] = useState<string | undefined>();
  const ax = analysisIndex(item);
  const preview = mode === "preview";
  const aOptions: any[] = item.partA?.options ?? [];
  const bOptions: any[] = item.partB?.options ?? [];
  const aOk = !!aOptions.find((o: any) => o.key === partA)?.correct;
  const bOk = !!bOptions.find((o: any) => o.key === partB)?.correct;
  const answered = partA !== undefined && partB !== undefined;

  const pick = (part: "A" | "B", key: string) => {
    if (part === "A") setPartA(key);
    else setPartB(key);
    respond({ partA: part === "A" ? key : partA, partB: part === "B" ? key : partB });
  };

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-2">
        <StemLine>Part A. {item.stem?.partA}</StemLine>
        {aOptions.map((o: any) => (
          <OptionRow
            key={o.key}
            name={`${item.id}-A`}
            optKey={o.key}
            selected={partA === o.key}
            onSelect={() => pick("A", o.key)}
            mode={mode}
            correct={o.correct}
            analysis={ax[`A:${o.key}`]}
            feedback={preview && partA !== undefined}
          >
            {o.text}
          </OptionRow>
        ))}
      </div>
      <div className="flex flex-col gap-2">
        <StemLine>Part B. {item.stem?.partB}</StemLine>
        {bOptions.map((o: any) => (
          <OptionRow
            key={o.key}
            name={`${item.id}-B`}
            optKey={o.key}
            selected={partB === o.key}
            onSelect={() => pick("B", o.key)}
            mode={mode}
            correct={o.correct}
            analysis={ax[`B:${o.key}`]}
            feedback={preview && partB !== undefined}
          >
            <span className="italic">“{o.text}”</span>
          </OptionRow>
        ))}
      </div>
      {preview && answered && (
        <ResultBanner correct={aOk && bOk}>
          {aOk && bOk
            ? "Correct — 1 / 1 point."
            : `Not quite — 0 / 1 point.  (Part A ${aOk ? "✓" : "✗"} · Part B ${bOk ? "✓" : "✗"})`}
        </ResultBanner>
      )}
    </div>
  );
}
