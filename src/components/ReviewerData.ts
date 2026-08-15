import type { TierInfo } from "../types.ts";

/**
 * All 40 reviewer personalities organized by tier.
 * Condensed metadata used by ExpertPicker for TUI selection.
 * Full verbose personality blocks live in skillContent.ts.
 */
export const TIERS: TierInfo[] = [
  // ── Holistic (5) ────────────────────────────────────────────────────────
  {
    tier: "holistic",
    label: "Holistic",
    reviewers: [
      {
        name: "Principal Engineer",
        description: "Deep experience in software architecture, system design, and engineering best practices.",
        focusAreas: ["Architecture & Design", "Maintainability", "Scalability", "Technical Debt", "Cross-cutting Concerns", "API Design"],
      },
      {
        name: "Software Architect",
        description: "Deep expertise in system boundaries, integration patterns, and evolutionary architecture. Every change either makes a system easier or harder to evolve.",
        focusAreas: ["System Boundaries", "Contracts & Interfaces", "Coupling & Cohesion", "Integration Patterns", "Evolutionary Architecture", "Architectural Fitness"],
      },
      {
        name: "Full-Stack Engineer",
        description: "Thinks in vertical slices — from the user's click to the database row and back. Strength is seeing gaps where frontend and backend assumptions diverge.",
        focusAreas: ["End-to-End Coherence", "Data Contract Alignment", "Validation Consistency", "Error Propagation", "State Management", "UX Impact of Backend Changes"],
      },
      {
        name: "Reliability Engineer",
        description: "Thinks in failure modes — not whether code works today, but how it breaks.",
        focusAreas: ["Observability", "Failure Detection", "Error Handling & Recovery", "Diagnostics"],
      },
      {
        name: "Staff Engineer",
        description: "Operates at the intersection of technology and organization.",
        focusAreas: ["Cross-Team Impact", "Technical Strategy", "Knowledge Transfer", "Reuse & Duplication"],
      },
    ],
  },
  // ── Specialist (15) ─────────────────────────────────────────────────────
  {
    tier: "specialist",
    label: "Specialist",
    reviewers: [
      {
        name: "Code Quality Engineer",
        description: "Expertise in clean code practices, readability, and maintainable software.",
        focusAreas: ["Readability", "Code Style", "Naming", "Complexity", "Documentation", "Error Handling"],
      },
      {
        name: "Security Engineer",
        description: "Deep expertise in application security, threat modeling, and secure coding.",
        focusAreas: ["Auth", "Input Validation", "Data Protection", "Injection Prevention", "Cryptography"],
      },
      {
        name: "Testing Engineer",
        description: "Expertise in test strategy, test design, and quality assurance.",
        focusAreas: ["Test Coverage", "Test Quality", "Edge Cases", "Testability", "Test Maintenance"],
      },
      {
        name: "Frontend Engineer",
        description: "Deep experience in component architecture, rendering performance, and accessible interfaces.",
        focusAreas: ["Component Design", "State Management", "Rendering Performance", "Accessibility", "CSS", "Bundle Size"],
      },
      {
        name: "Backend Engineer",
        description: "Deep experience in API design, distributed systems, and data modeling.",
        focusAreas: ["API Design", "Data Modeling", "Concurrency & Safety", "Observability", "Error Handling"],
      },
      {
        name: "Performance Engineer",
        description: "Deep experience in profiling, optimization, and behavior under load.",
        focusAreas: ["Algorithmic Complexity", "Bottlenecks", "Caching", "Memory & CPU Efficiency"],
      },
      {
        name: "Accessibility Engineer",
        description: "Deep experience in inclusive design and assistive technology compatibility.",
        focusAreas: ["WCAG 2.1 AA", "Screen Reader", "Keyboard Navigation", "Color & Contrast", "ARIA", "Focus Management"],
      },
      {
        name: "DevOps Engineer",
        description: "Deep experience in CI/CD systems, release engineering, and operational reliability.",
        focusAreas: ["CI/CD Pipelines", "Infrastructure as Code", "Rollback Safety", "Monitoring", "Secrets Management"],
      },
      {
        name: "Data Engineer",
        description: "Deep experience in schema design, query optimization, and data integrity.",
        focusAreas: ["Schema Design", "Migrations", "Query Efficiency", "Data Integrity", "Indexing Strategy"],
      },
      {
        name: "Infrastructure Engineer",
        description: "Deep experience in cloud architecture, deployment systems, and IaC.",
        focusAreas: ["Deployment Safety", "Scaling Patterns", "Resource Efficiency", "Cloud-Native", "Cost Awareness"],
      },
      {
        name: "DX Engineer",
        description: "Deep experience in API ergonomics, tooling design, and reducing developer friction.",
        focusAreas: ["API Ergonomics", "Error Messages", "SDK Design", "Developer Productivity", "Onboarding Friction"],
      },
      {
        name: "Mobile Engineer",
        description: "Deep experience across iOS and Android — limited resources, unreliable networks.",
        focusAreas: ["Platform Conventions", "Offline-First", "Battery & Memory Efficiency", "Gestures", "Deep Linking"],
      },
      {
        name: "AI Engineer",
        description: "Deep experience in LLM integration, prompt engineering, and AI-powered features.",
        focusAreas: ["Prompt Design", "Model Integration", "Safety & Guardrails", "Cost & Latency", "Evaluation"],
      },
      {
        name: "Documentation Writer",
        description: "Deep expertise in clear, precise, audience-appropriate documentation.",
        focusAreas: ["Audience Alignment", "Clarity & Precision", "Structural Coherence", "Completeness"],
      },
      {
        name: "Slop Auditor",
        description: "Audits for \"coding slop\" — code that looks plausible but adds cost without adding value.",
        focusAreas: ["Comments & Docs", "Dead Weight", "False Robustness", "Speculative Generality", "Duplication & Reinvention", "Tests That Don't Test", "Noise"],
      },
    ],
  },
  // ── Persona (20) ────────────────────────────────────────────────────────
  {
    tier: "persona",
    label: "Persona",
    reviewers: [
      {
        name: "Martin Fowler",
        description: "\"Code should be easy to change. Good design makes future change cheap.\"",
        focusAreas: ["Code Smells", "Refactoring", "Evolutionary Design", "Patterns vs. Over-Engineering"],
      },
      {
        name: "Kent Beck",
        description: "\"Make it work, make it right, make it fast — in that order.\"",
        focusAreas: ["Simplicity", "TDD", "Small Increments", "YAGNI", "Communication Through Code"],
      },
      {
        name: "Sandi Metz",
        description: "\"Prefer duplication over the wrong abstraction.\"",
        focusAreas: ["Object Design", "Dependencies & Messages", "Abstraction Timing", "Dependency Direction"],
      },
      {
        name: "Rich Hickey",
        description: "\"Simple is not easy. Complecting independent concerns is the root cause of difficulty.\"",
        focusAreas: ["Simplicity vs. Easiness", "Complecting Audit", "Immutability", "Value-Oriented Design"],
      },
      {
        name: "Anders Hejlsberg",
        description: "\"Type systems should serve developers, not the other way around.\"",
        focusAreas: ["Type Safety", "Type Ergonomics", "API Design for Types", "Generic Design"],
      },
      {
        name: "John Ousterhout",
        description: "\"Complexity is the root cause of most software problems. Fight it with deep modules.\"",
        focusAreas: ["Deep vs. Shallow Modules", "Information Hiding", "Strategic vs. Tactical", "Complexity Budget"],
      },
      {
        name: "Kamil Mysliwiec",
        description: "\"Modular, progressive architecture with DI scales from prototype to production.\"",
        focusAreas: ["Module Boundaries", "Dependency Injection", "Decorator Patterns", "Progressive Complexity"],
      },
      {
        name: "Kent Dodds",
        description: "\"Write components that are simple, composable, and easy to test.\"",
        focusAreas: ["React Composition", "Colocation & Simplicity", "Custom Hooks", "User-Centric Testing"],
      },
      {
        name: "Tanner Linsley",
        description: "\"Libraries should be headless and framework-agnostic. Composability beats configuration.\"",
        focusAreas: ["Composability", "Headless Patterns", "Framework-Agnostic Core", "State Synchronization"],
      },
      {
        name: "Vladimir Khorikov",
        description: "\"Tests should maximize regression protection while minimizing maintenance cost.\"",
        focusAreas: ["Test Value", "Domain vs. Infrastructure Separation", "Functional Core / Imperative Shell"],
      },
      {
        name: "Michael Feathers",
        description: "\"Legacy code is code without tests. You cannot change what you cannot verify.\"",
        focusAreas: ["Seams & Testability", "Characterization Tests", "Dependency Breaking", "Safe Change Strategy"],
      },
      {
        name: "Rob Pike",
        description: "\"Simplicity is complicated. Clarity beats cleverness; a little copying beats a little dependency.\"",
        focusAreas: ["Clarity Over Cleverness", "Small Interfaces", "Orthogonality", "Dependency Discipline"],
      },
      {
        name: "Bryan Cantrill",
        description: "\"Systems must be built to be understood when they fail.\"",
        focusAreas: ["Debuggability", "Failure Semantics", "Postmortem Diagnosability", "Abstraction Honesty"],
      },
      {
        name: "Charity Majors",
        description: "\"Observability means asking arbitrary new questions of your system without shipping new code.\"",
        focusAreas: ["Instrumentation Quality", "High-Cardinality Context", "Production Ownership", "Deploy Safety"],
      },
      {
        name: "Barbara Liskov",
        description: "\"An abstraction is defined by its specification, not its implementation.\"",
        focusAreas: ["Abstraction Contracts", "Substitutability", "Representation Invariants", "Modular Reasoning"],
      },
      {
        name: "Casey Muratori",
        description: "\"Write the obvious code first; compress into abstractions only after real duplication proves them.\"",
        focusAreas: ["Semantic Compression", "Premature Abstraction", "Cost of Indirection", "Data Layout"],
      },
      {
        name: "Titus Winters",
        description: "\"Software engineering is programming integrated over time.\"",
        focusAreas: ["Hyrum's Law Exposure", "API Lifecycle", "Sustainable Change", "Rule Consistency"],
      },
      {
        name: "Julia Evans",
        description: "\"If code confuses a capable reader, the code has a bug.\"",
        focusAreas: ["Comprehensibility", "Debugging Affordances", "Error Message Quality", "Docs That Teach"],
      },
      {
        name: "Linus Torvalds",
        description: "\"Bad programmers worry about the code. Good programmers worry about data structures and their relationships.\"",
        focusAreas: ["Good Taste", "Data Structures Over Code", "Never Break Userspace", "Commit & Bisect Hygiene"],
      },
      {
        name: "Ponytail Dev",
        description: "\"The best code is the code you never wrote.\"",
        focusAreas: ["YAGNI", "Reuse Ladder", "Deletion Opportunities", "One-Line Replacements", "Safety Floor"],
      },
    ],
  },
];