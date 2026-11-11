// SPDX-License-Identifier: MIT
/**
 * The face of an edge label, a filled line-label blank, or an empty one. Rendered on the web
 * AND in the offscreen measuring layer, from the same component, so the room the layout reserves
 * is the room the label takes. Colours vary; size depends only on `kind` and `text`.
 */
import { RichText } from "../../lib/text";
import { LABEL, LABEL_CONTENT, type CandidateKind } from "../../lib/metrics";
import { FitBox } from "./FitBox";

export function LabelFace({
  kind,
  text,
  className = "",
}: {
  kind: CandidateKind;
  /** null: the empty blank's placeholder. */
  text: string | null;
  className?: string;
}) {
  return (
    <span
      className={`flex items-center justify-center rounded-2xl text-center ${className}`}
      style={{
        boxSizing: "border-box",
        borderWidth: LABEL.border,
        borderStyle: kind === "blank" && text === null ? "dashed" : "solid",
        padding: `${LABEL.padY}px ${LABEL.padX}px`,
        fontSize: LABEL.font,
        lineHeight: `${LABEL.line}px`,
        maxWidth: LABEL.maxW,
        maxHeight: LABEL.maxH,
        minWidth: kind === "blank" ? LABEL.blankMinW : undefined,
      }}
    >
      <FitBox maxW={LABEL_CONTENT.w} maxH={LABEL_CONTENT.h}>
        {text === null ? (
          <span aria-hidden="true">?</span>
        ) : (
          <RichText text={text} imageBox={{ w: LABEL.imgW, h: LABEL.imgH }} />
        )}
      </FitBox>
    </span>
  );
}
