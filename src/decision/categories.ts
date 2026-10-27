/**
 * Reviewer categories: the compact vocabulary the decision classifier answers
 * over, and the deterministic expansion of each one into exact catalogue names.
 *
 * The catalogue has 53 reviewers, far too many for one choice question, so the
 * classifier answers one yes/no question per category and the expansion is a
 * pure lookup. Every category lists the reviewers that tier already groups
 * together, so a category never invents coverage the picker does not offer.
 *
 * Invariants held by `test/decisionDispatch.test.ts`:
 * - every name resolves through the dispatcher's catalogue lookup;
 * - every catalogue name is reachable from at least one category.
 */

import type { TierInfo } from "../types.ts";

/** One reviewer category the classifier can answer for. */
export interface ReviewerCategory {
  /** Stable key, also the classifier's question name. */
  id: string;
  /** Short label used in a recommendation's reason. */
  label: string;
  /** When this category applies, judged from the fingerprint alone. */
  criteria: string;
  /** Exact catalogue names this category expands to. */
  reviewers: string[];
}

/**
 * The categories, ordered from the always-applicable holistic pass to the
 * signal-specific specialists.
 */
export const REVIEWER_CATEGORIES: readonly ReviewerCategory[] = [
  {
    id: "architecture",
    label: "architecture and system design",
    criteria:
      "Almost any audit of more than a handful of files, and any change that crosses module, service, or team boundaries. False only for a single trivial file with no callers.",
    reviewers: ["Principal Engineer", "Software Architect", "Staff Engineer", "Full-Stack Engineer"],
  },
  {
    id: "maintainability",
    label: "maintainability and code quality",
    criteria:
      "Non-trivial logic, duplicated structure, deep conditionals, speculative generality, or comments that restate the code instead of explaining why.",
    reviewers: [
      "Code Quality Engineer",
      "Martin Fowler",
      "Sandi Metz",
      "Rich Hickey",
      "John Ousterhout",
      "Rob Pike",
      "Slop Auditor",
      "Ponytail Dev",
    ],
  },
  {
    id: "testing",
    label: "test strategy and testability",
    criteria:
      "The fingerprint shows tests, a test framework, or spec files, or the change touches code that has no corresponding test.",
    reviewers: ["Testing Engineer", "Kent Beck", "Vladimir Khorikov", "Michael Feathers"],
  },
  {
    id: "security",
    label: "application security",
    criteria:
      "Network-facing code, untrusted input, serialization or deserialization, file and path handling, or user-visible output that could carry injected content.",
    reviewers: [
      "Security Engineer",
      "Injection & Input Handling Specialist",
      "Browser Trust Boundary Specialist",
      "Business Logic & Abuse Specialist",
      "Secrets, Data & Exposure Specialist",
    ],
  },
  {
    id: "auth",
    label: "authentication and authorization",
    criteria:
      "The auth signal fired, or the auth evidence names login, session, token, permission, or tenant code that decides who may do what.",
    reviewers: ["Authorization & Tenancy Specialist", "Authentication & Session Specialist"],
  },
  {
    id: "cryptography",
    label: "cryptography and protocols",
    criteria:
      "The crypto signal fired, or the change touches hashing, signing, key handling, randomness, TLS configuration, or a custom wire protocol.",
    reviewers: ["Cryptography & Protocol Specialist"],
  },
  {
    id: "native",
    label: "native and memory-unsafe code",
    criteria:
      "A native language (C, C++, Rust, Swift), the native signal, or FFI, wasm, unsafe blocks, and pointer or lifetime handling.",
    reviewers: ["Memory Safety & Native Code Specialist", "Embedded & Hardware Specialist"],
  },
  {
    id: "concurrency",
    label: "concurrency and state machines",
    criteria:
      "Async, worker, thread, job, queue, retry, or scheduler code, or state that changes under more than one actor at a time.",
    reviewers: ["Concurrency & State Machine Specialist", "Reliability Engineer", "Bryan Cantrill"],
  },
  {
    id: "frontend",
    label: "frontend and accessibility",
    criteria:
      "A UI framework (React, Vue, Svelte, Angular), component or style files, or any change a screen reader or keyboard user would notice.",
    reviewers: ["Frontend Engineer", "Kent Dodds", "Tanner Linsley", "Accessibility Engineer", "Mobile Engineer"],
  },
  {
    id: "backend",
    label: "backend and API design",
    criteria:
      "A server framework, HTTP or RPC routes, a service boundary, or request and response handling.",
    reviewers: ["Backend Engineer", "DX Engineer", "Kamil Mysliwiec", "Titus Winters"],
  },
  {
    id: "data",
    label: "data modeling and queries",
    criteria:
      "A database driver or ORM, migrations, schema files, or queries over tables and indexes.",
    reviewers: ["Data Engineer"],
  },
  {
    id: "performance",
    label: "performance",
    criteria:
      "Hot paths, large data volumes, caching, loops over collections, allocation churn, or rendering and layout cost.",
    reviewers: ["Performance Engineer", "Casey Muratori", "Linus Torvalds"],
  },
  {
    id: "observability",
    label: "observability and diagnosability",
    criteria:
      "Logging, metrics, tracing, error reporting, or the operational tooling someone uses at 3am.",
    reviewers: ["Reliability Engineer", "Charity Majors", "Julia Evans"],
  },
  {
    id: "infrastructure",
    label: "infrastructure and supply chain",
    criteria:
      "Containers, CI, infrastructure as code, deployment configuration, dependency manifests, or pipeline files.",
    reviewers: ["DevOps Engineer", "Infrastructure Engineer", "Infrastructure & Supply Chain Specialist"],
  },
  {
    id: "ai",
    label: "AI and agent surfaces",
    criteria:
      "An LLM or agent SDK, prompts, tool definitions, retrieval, or any code whose input or output a model can influence.",
    reviewers: ["AI Engineer", "AI & Agent Surface Specialist"],
  },
  {
    id: "docs",
    label: "documentation",
    criteria:
      "README and docs directories, docstrings, or a change whose main risk is that a reader will misunderstand it.",
    reviewers: ["Documentation Writer", "Julia Evans"],
  },
  {
    id: "desktop-ipc",
    label: "desktop, mobile, and IPC surfaces",
    criteria:
      "Electron, Tauri, a mobile app, deep links, URL schemes, or local inter-process communication.",
    reviewers: ["Client & IPC Surface Specialist"],
  },
  {
    id: "contracts",
    label: "contracts and type design",
    criteria:
      "A public API surface, exported types, an SDK others compile against, or a signature whose callers cannot all be seen here.",
    reviewers: ["Software Architect", "Barbara Liskov", "Anders Hejlsberg", "DX Engineer"],
  },
] as const;

export const REVIEWER_CATEGORY_IDS: readonly string[] = REVIEWER_CATEGORIES.map((category) => category.id);

/** Exact catalogue names of the holistic tier, derived from the catalogue rather than hardcoded. */
export function holisticReviewerNames(tiers: readonly TierInfo[]): string[] {
  return tiers.find((tier) => tier.tier === "holistic")?.reviewers.map((reviewer) => reviewer.name) ?? [];
}
