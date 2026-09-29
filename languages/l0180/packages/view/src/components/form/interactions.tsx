// SPDX-License-Identifier: MIT
/**
 * The interaction registry, in its own module so an item can render its parts without a cycle:
 * Form → ItemView → InteractionView → ChoiceItem, and Form → InteractionView for a bare
 * interaction. Nothing here knows about `item`; that is ItemView's job.
 *
 * Adding an interaction type means adding a line to RENDERERS and nothing else.
 */
import type { Validation } from "../../scoring";
import { ChoiceItem } from "./ChoiceItem";
import { HottextItem } from "./HottextItem";
import { ExtendedTextItem } from "./ExtendedTextItem";
import { TextEntryItem } from "./TextEntryItem";
import { InlineChoiceItem } from "./InlineChoiceItem";
import { OrderItem } from "./OrderItem";
import { PairingItem } from "./PairingItem";
import { GapMatchItem } from "./GapMatchItem";
import { ErrorList } from "./itemKit";

export interface InteractionProps {
  interaction: any;
  validation?: Validation;
  response: unknown;
  respond: (response: any) => void;
  /** False for a part inside an item — only the item reports a score. */
  showResult?: boolean;
}

const RENDERERS: Record<string, (p: InteractionProps) => JSX.Element> = {
  choice: ChoiceItem as any,
  hottext: HottextItem as any,
  "extended-text": ExtendedTextItem as any,
  "text-entry": TextEntryItem as any,
  "inline-choice": InlineChoiceItem as any,
  order: OrderItem as any,
  // One component for both: at this level they are the same question, one choice per row.
  match: PairingItem as any,
  classification: PairingItem as any,
  "gap-match": GapMatchItem as any,
};

export function InteractionView(props: InteractionProps) {
  const type = props.interaction?.type;
  const Renderer = type ? RENDERERS[type] : undefined;
  if (!Renderer) {
    // A newer item than this build knows about. Say so plainly rather than rendering a blank
    // card that looks like a broken question.
    return (
      <ErrorList
        errors={[
          {
            message:
              `This build cannot render a "${type}" interaction. ` +
              `It knows: ${Object.keys(RENDERERS).join(", ")}.`,
          },
        ]}
      />
    );
  }
  return <Renderer {...props} />;
}

export const knownInteractions = () => Object.keys(RENDERERS);
