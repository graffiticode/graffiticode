# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Development Commands

### Running the application
```bash
# Start development server with Firebase emulator
npm run dev

# Start production server
npm start
```

### Testing
```bash
# Run tests with Firebase emulator
npm test

# Run tests with coverage
npm run coverage
```

### Linting
```bash
# Lint code
npm run lint

# Lint and automatically fix issues
npm run lint:fix
```

## Architecture Overview

This is the Graffiticode API Gateway - a service that acts as the central compilation and task management system for the Graffiticode ecosystem.

### Core Components

1. **Express App Structure** (`src/app.js`): The main application creates an Express server with:
   - Authentication middleware using JWT tokens validated against an auth service
   - Multiple route handlers for different API endpoints
   - Firebase Firestore for data persistence
   - Error handling middleware

2. **Route Handlers** (`src/routes/`):
   - `/compile` - Handles code compilation requests
   - `/task`, `/tasks` - Task creation and management
   - `/data` - Data API operations  
   - `/lang`, `/L*` - Language-specific endpoints
   - `/form` - Form-related operations
   - `/config` - Configuration management

3. **Storage Layer** (`src/storage/`):
   - Uses Firebase Admin SDK for Firestore operations
   - `compileStorer` - Stores and retrieves compilation results
   - `taskStorer` - Manages task persistence

4. **Language Compilation** (`src/lang/`):
   - Handles language-specific compilation logic
   - Integrates with external compiler services

5. **Authentication** (`src/auth.js`):
   - JWT token validation
   - Integration with external auth service (configured via AUTH_URL environment variable)

## Important Configuration

- **Environment Variables**:
  - `PORT` - Server port (default: 3100)
  - `AUTH_URL` - Authentication service URL
  - `LOCAL_COMPILES` - Enable local compilation mode
  - `FIRESTORE_EMULATOR_HOST` - Firebase emulator host for development
  - `CONFIG` - Path to config file (default: `config/config.json`)

- **ESLint Configuration**: Uses parent `.eslintrc.cjs` with:
  - Standard style guide
  - ES2022 features
  - Required double quotes and semicolons
  - Import extensions required
  - No CommonJS modules (ES modules only)

## Testing Approach

- Uses Jest with Firebase emulators for integration testing
- Test files are co-located with source files (*.spec.js pattern)
- Firebase emulator automatically starts when running tests
- Tests run in band (sequentially) to avoid conflicts