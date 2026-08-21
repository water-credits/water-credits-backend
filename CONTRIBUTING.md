# Contributing to Water Credits Backend

Thank you for your interest in contributing! We welcome contributions from everyone.

## Table of Contents

- [Code of Conduct](#code-of-conduct)
- [Getting Started](#getting-started)
- [Development Workflow](#development-workflow)
- [Project Structure](#project-structure)
- [Coding Standards](#coding-standards)
- [Testing](#testing)
- [Pull Request Process](#pull-request-process)
- [Commit Convention](#commit-convention)
- [Issue Reporting](#issue-reporting)

## Code of Conduct

This project is governed by the [Contributor Covenant](https://www.contributor-covenant.org/). By participating, you agree to uphold this code. Report unacceptable behavior to the maintainers.

## Getting Started

### Prerequisites

- **Node.js** >= 20 (see `.nvmrc`)
- **npm** >= 10
- **PostgreSQL** >= 15
- **Redis** >= 7

### Local Setup

```bash
# Clone the repository
git clone https://github.com/water-credits/water-credits-backend.git
cd water-credits-backend

# Use the correct Node version
nvm use

# Install dependencies
npm install

# Copy environment variables
cp .env.example .env

# Create the database
createdb water_credits

# Run database migrations
npm run migration:run

# Start in development mode
npm run start:dev
```

The API will be available at `http://localhost:3001`.

### Stellar Keypair Setup

The backend needs a Stellar account to sign oracle submissions and interact with Soroban contracts. For local development, generate a testnet keypair using the [Stellar Laboratory](https://laboratory.stellar.org/#account-creator?network=test):

1. Go to the Stellar Laboratory Account Creator (testnet)
2. Click **Generate keypair** — you'll get a public key (`G...`) and secret key (`S...`)
3. Click **Fund account with Friendbot** to activate it on testnet
4. Set the values in your `.env`:

```bash
STELLAR_BACKEND_PUBLIC=GABC...   # the G... key
STELLAR_BACKEND_SECRET=SABC...   # the S... key
```

> **Never commit your secret key.** The `.gitignore` already excludes `.env`, but double-check before pushing.

For oracle-specific keys, repeat the same steps and populate `ORACLE_ADDRESS` and `ORACLE_SECRET`.

Without a valid STELLAR_BACKEND_SECRET, the API still starts (random keypair fallback) but GET /api/v1/health reports checks.stellar.signing_ready: false and status: "degraded". For production-like boots, set STELLAR_REQUIRE_SIGNING_KEY=true so the process refuses to start if the secret is unusable.

### Using Docker (alternative)

```bash
docker compose up -d
```

This starts PostgreSQL, Redis, and the API server with live reload.

## Development Workflow

1. Find or create an issue for the work you want to do
2. Create a feature branch from `main`
3. Make your changes following the coding standards
4. Write or update tests
5. Run the test suite and linting
6. Submit a pull request

### Branch Naming

| Pattern              | Purpose                    |
|----------------------|----------------------------|
| `feat/*`             | New features               |
| `fix/*`              | Bug fixes                  |
| `chore/*`            | Maintenance tasks          |
| `docs/*`             | Documentation changes      |
| `refactor/*`         | Code refactoring           |
| `test/*`             | Test additions or changes  |

## Project Structure

```
src/
├── main.ts                  # Application entry point
├── app.module.ts            # Root module
├── common/                  # Shared utilities
│   ├── decorators/
│   ├── dto/
│   ├── filters/
│   ├── guards/
│   ├── interceptors/
│   └── pipes/
├── config/                  # Configuration modules
├── migrations/              # SQL migration files
└── modules/                 # Feature modules
    ├── auth/
    ├── users/
    ├── projects/
    ├── sensors/
    ├── credits/
    ├── oracle/
    ├── governance/
    ├── analytics/
    ├── notifications/
    └── stellar/
```

Each module follows the NestJS convention:

```
module/
├── dto/                     # Data transfer objects
├── entities/                # TypeORM entities
├── *.controller.ts          # Route handlers
├── *.controller.spec.ts     # Controller tests
├── *.service.ts             # Business logic
├── *.service.spec.ts        # Service tests
├── *.module.ts              # Module definition
└── *.processor.ts           # Bull queue processors (if applicable)
```

## Coding Standards

### TypeScript

- **Strict mode** is enabled — avoid using `any`
- Use the path aliases defined in `tsconfig.json`:
  - `@common/*` → `src/common/*`
  - `@config/*` → `src/config/*`
  - `@modules/*` → `src/modules/*`
- Use `class-validator` decorators for DTO validation
- Use TypeORM decorators for entity definitions

### Linting & Formatting

```bash
# Check linting
npm run lint

# Auto-fix linting issues
npm run lint -- --fix

# Format code
npm run format
```

We enforce:
- **ESLint** with TypeScript rules
- **Prettier** for consistent formatting
- 2-space indentation
- Single quotes
- Semicolons required
- 100-character line width

### Code Style

- Use descriptive, PascalCase for classes and interfaces
- Use camelCase for variables, functions, and methods
- Use kebab-case for file names (e.g., `auth.service.ts`)
- Prefer `readonly` for immutable properties
- Use `const` over `let` where possible
- Use `async/await` over raw promises
- Use NestJS lifecycle hooks (`OnModuleInit`, `OnModuleDestroy`) for startup/shutdown logic

## Testing

We use **Jest** with `ts-jest` for testing.

### Running Tests

```bash
# Run all unit tests
npm test

# Run with watch mode
npm run test:watch

# Run with coverage
npm run test:cov

# Run e2e tests (requires database)
npm run test:e2e
```

### Test Guidelines

- Write **unit tests** for all services and controllers
- Mock external dependencies (database, Stellar RPC, Redis)
- Use `@nestjs/testing` `Test.createTestingModule` for module isolation
- Test both success and error paths
- Name tests with the pattern: `should ... when ...`

## Pull Request Process

1. Ensure your code builds: `npm run build`
2. Ensure all tests pass: `npm test`
3. Ensure linting passes: `npm run lint`
4. Update the README or documentation if needed
5. Create a pull request with a clear title and description
6. Reference the related issue(s)
7. Wait for review and address feedback

### PR Title Format

Use [conventional commits](https://www.conventionalcommits.org/) style:

```
feat: add batch credit issuance endpoint
fix: handle empty sensor reading batches
docs: update API reference for oracle module
refactor: extract Stellar client into shared service
```

### PR Checklist

- [ ] Code follows the project's coding standards
- [ ] Tests added/updated and passing
- [ ] Documentation updated (if applicable)
- [ ] Changes are backward-compatible or migration plan is documented
- [ ] Commit messages follow the conventional commit format

## Commit Convention

We follow [Conventional Commits](https://www.conventionalcommits.org/):

```
<type>(<scope>): <description>

[optional body]

[optional footer]
```

### Types

| Type       | Usage                                  |
|------------|----------------------------------------|
| `feat`     | A new feature                          |
| `fix`      | A bug fix                              |
| `docs`     | Documentation changes                  |
| `style`    | Formatting, missing semicolons, etc.   |
| `refactor` | Code refactoring                       |
| `perf`     | Performance improvements               |
| `test`     | Adding or correcting tests             |
| `build`    | Build system or dependency changes     |
| `ci`       | CI configuration changes               |
| `chore`    | Other maintenance tasks                |

### Examples

```
feat(auth): implement Stellar wallet challenge-response
fix(oracle): handle timeout on Soroban submission
docs(api): add rate limit headers to response docs
refactor(sensors): extract validation logic to pipe
```

## Issue Reporting

### Bug Reports

Include:
- A clear, descriptive title
- Steps to reproduce
- Expected vs actual behavior
- Environment details (Node version, OS, database version)
- Relevant logs or error messages
- If applicable, a minimal code reproduction

### Feature Requests

Include:
- A clear, descriptive title
- The problem or use case
- Proposed solution or API design
- Alternative approaches considered
- Any relevant context or examples

## Questions & Discussion

- Open a [Discussion](https://github.com/water-credits/water-credits-backend/discussions)
- Chat directly on Telegram — [@Escelit](https://t.me/Escelit)
- Email general enquiries to [ogazipromise81@gmail.com](mailto:ogazipromise81@gmail.com)
- Check existing issues and PRs before posting

---

Thank you for contributing! 🚀
