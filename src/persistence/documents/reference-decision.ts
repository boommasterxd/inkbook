export type ReferenceKnowledge =
  { readonly state: "unresolved" } | { readonly state: "resolved"; readonly references: number };

export type EmbedDeletionDecision =
  | { readonly removeEmbed: true; readonly mayOfferFileDeletion: false }
  | { readonly removeEmbed: true; readonly mayOfferFileDeletion: true };

export function decideEmbedDeletion(knowledge: ReferenceKnowledge): EmbedDeletionDecision {
  if (knowledge.state === "unresolved" || knowledge.references > 1) {
    return { removeEmbed: true, mayOfferFileDeletion: false };
  }
  return { removeEmbed: true, mayOfferFileDeletion: true };
}

export function mayDeleteManagedFile(
  knowledge: ReferenceKnowledge,
  userConfirmed: boolean,
): boolean {
  return knowledge.state === "resolved" && knowledge.references <= 1 && userConfirmed;
}
