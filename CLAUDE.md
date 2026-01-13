# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Build and Development Commands

This is a monorepo using npm workspaces with four packages: api, auth, auth-client, common, and parser.

### Root-level commands
```bash
npm run emulator     # Start Firebase emulators (Firestore on 8080, Auth on 9099)
npm run api          # Run api package dev server
npm run auth         # Run auth package dev server
npm test             # Run root-level tests with Firebase emulators
npm run lint         # Lint root test/ directory
```

### Package-specific commands
```bash
# API package (packages/api)
npm run -w packages/api dev       # Dev server with emulator env vars
npm run -w packages/api test      # Tests with Firebase emulators
npm run -w packages/api lint      # Lint src/ and tools/

# Auth package (packages/auth)
npm run -w packages/auth dev      # Dev server with emulator env vars
npm run -w packages/auth test     # Tests with Firebase emulators
npm run -w packages/auth lint

# Parser package (packages/parser)
npm run -w packages/parser test   # Tests with experimental VM modules
npm run -w packages/parser lint

# Common package (packages/common)
npm run -w packages/common test
npm run -w packages/common lint

# Auth-client package (packages/auth-client)
npm run -w packages/auth-client test
npm run -w packages/auth-client lint
```

### Running a single test
```bash
NODE_OPTIONS=--experimental-vm-modules jest path/to/file.spec.js
# For packages requiring emulators:
NODE_OPTIONS=--experimental-vm-modules firebase emulators:exec "jest path/to/file.spec.js"
```

## Architecture Overview

Graffiticode is a platform for compilers as a service. The system consists of:

**@graffiticode/api** - API Gateway that handles code compilation requests and task management. Routes compile requests to language-specific compilers, stores results in Firestore.

**@graffiticode/auth** - Authentication service using Sign In With Ethereum (SIWE). Issues JWT access tokens and refresh tokens. Validates Ethereum signatures for user authentication.

**@graffiticode/auth-client** - Client library for authenticating with the auth service.

**@graffiticode/parser** - Core parser that converts Graffiticode language syntax into ASTs. Used by the API for parsing user code before compilation.

**@graffiticode/common** - Shared utilities: error handling, HTTP helpers, parser utilities.

### Key Integration Points

- API validates JWT tokens against auth service (AUTH_URL env var)
- Parser integrates with language lexicons loaded from API's lang module
- All packages use Firebase Admin SDK; development uses Firebase emulators
- Tests require `--experimental-vm-modules` flag for ES module support

## Code Style

ESLint config enforces:
- Double quotes, semicolons required
- ES modules only (no CommonJS)
- Import extensions required (`.js`)
- Standard style guide base
