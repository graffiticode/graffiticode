# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Development Commands

### Testing
```bash
# Run all tests with experimental VM modules
npm test

# Run specific test files
NODE_OPTIONS=--experimental-vm-modules jest src/parser.spec.js
```

### Linting
```bash
# Lint code
npm run lint

# Lint and automatically fix issues
npm run lint:fix
```

## Architecture Overview

This is the Graffiticode parser package - a core component that parses Graffiticode language syntax into ASTs (Abstract Syntax Trees).

### Package Structure

The parser is a workspace package within the Graffiticode monorepo. It's an ES module package (`"type": "module"`) that exports parsing functionality used by the API and language compilers.

### Core Components

1. **Parser Entry Point** (`src/parser.js`):
   - `buildParser()` - Factory function that creates a parser instance with dependencies
   - Integrates with language lexicons loaded from the API
   - Uses Node.js VM module for sandboxed execution

2. **Core Parser** (`src/parse.js`):
   - Implements the main parsing logic with a state machine approach
   - Handles tokenization and AST construction
   - Includes error tracking and position coordinates
   - Supports keywords, operators, and language-specific lexicons

3. **AST Module** (`src/ast.js`):
   - Manages AST node creation and manipulation
   - Node pooling for memory efficiency
   - Error node generation

4. **Environment** (`src/env.js`):
   - Manages parsing environment and scopes
   - Handles lexicon lookups

5. **Folder** (`src/folder.js`):
   - AST transformation and folding operations

## Testing Strategy

- Uses Jest with experimental VM modules support
- Test files follow `*.spec.js` pattern
- Main test file: `src/parser.spec.js` contains comprehensive parsing tests

## Monorepo Context

This parser package is part of the Graffiticode monorepo:
- Parent monorepo runs Firebase emulators for integration testing
- API package (`../api`) depends on this parser
- Auth packages (`../auth`, `../auth-client`) handle authentication
- Common package (`../common`) contains shared utilities

When working with the parser, be aware that it integrates tightly with the API's language loading mechanism (`../../api/src/lang/index.js`).