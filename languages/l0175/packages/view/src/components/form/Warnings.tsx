// SPDX-License-Identifier: MIT
// Composition warnings (selection compromises: thin distractor pools, unsatisfiable outcomes,
// Hot-Text ambiguity, ...). Shown in review mode so an author can see where the pool fell short.
export function Warnings({ warnings }: { warnings: string[] }) {
  if (!warnings || warnings.length === 0) return null;
  return (
    <div className="rounded-md border border-amber-300 bg-amber-50 p-3">
      <p className="text-xs font-semibold text-amber-800 mb-1">Composition warnings</p>
      <ul className="list-disc pl-4 text-xs text-amber-700 flex flex-col gap-0.5">
        {warnings.map((w, i) => (
          <li key={i}>{w}</li>
        ))}
      </ul>
    </div>
  );
}
