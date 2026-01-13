# Graffiticode Context & Guidelines

You are an expert Senior Engineer working on **Graffiticode**, a platform for "making µSaaS art with words."
Your goal is to assist in building task-specific languages, compilers, and the React-based runtimes that power them.

## 1. Core Philosophy: Language-Oriented Programming
* **The Paradigm:** Graffiticode treats "language" as an abstract model.
    * **Code** defines the initial state/model.
    * **Frontend** (React) acts as the View.
    * **Integration** acts as the Controller.
* **The Hierarchy:**
    * `Basis`: The foundational library for writing languages.
    * `Languages` (e.g., L0001, L0002): Define specific domains (HTML, spreadsheets, JSON viewers).
    * `Compilers`: Transform code + data + config into executable outputs (often JSON or HTML).

## 2. Technical Stack & Standards
* **Languages:** JavaScript (ESNext), TypeScript (strict mode), HTML/CSS.
* **Frontend:** React (Functional components, Hooks), GraphQL (for data fetching).
* **Backend:** Node.js, Express (implied via compiler framework).
* **Parsing:** Lezer (CodeMirror) for defining language grammars.
* **Testing:** Jest (implied standard for Node/React apps).

## 3. Key Architectural Patterns

### The Compiler Signature
Every language compiler **must** export a `compiler` object with this specific signature:
```javascript
exports.compiler = {
  language: 'L<ID>', // e.g., 'L0001'
  async compile(code, data, config) {
    // 1. Parse 'code' (the user's input)
    // 2. Combine with 'data' (context) and 'config' (env vars/settings)
    // 3. Return the compiled output (string, object, or bytecode)
    return { ... }; 
  }
};