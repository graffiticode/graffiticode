// SPDX-License-Identifier: MIT
/**
 * Local declarations for @graffiticode/l0179-view.
 *
 * WORKAROUND. That package publishes `dist/index.d.ts` containing only `export {}`, so it
 * offers no types to a TypeScript consumer. The cause is its vite build: `dts({rollupTypes:
 * true})` cannot inline re-exports from external packages (every export is re-exported from
 * @graffiticode/l0166 or @graffiticode/l0000-view), so it emits an empty module. Turning
 * rollupTypes off instead emits `dist/src/index.d.ts`, which is not where package.json points.
 *
 * This predates the Learnosity integration — it is not caused by it. Delete this file once
 * the view package emits real declarations.
 */
declare module "@graffiticode/l0179-view" {
  export const Form: (props: { state: any }) => any;
  export const scoreCells: (args: {
    cells: any;
    validation: any;
    interactionCells?: any;
  }) => any;
  export const getCellsValidation: (args: { cells: any; validation: any }) => any;
}

// The scorer imports scoring on its own subpath, so it never pulls in the renderer.
declare module "@graffiticode/l0179-view/scoring" {
  export const scoreCells: (args: {
    cells: any;
    validation: any;
    interactionCells?: any;
  }) => any;
  export const getCellsValidation: (args: { cells: any; validation: any }) => any;
}

declare module "@graffiticode/l0179-view/style.css";
declare module "@graffiticode/learnosity-cqt/styles.css";
