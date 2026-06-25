---
name: design-system
description: Use when proposing visual/UI directions, bootstrapping or extending a repository design-system playbook, enforcing token governance, or running render-and-critique design reviews.
---

# Design System Playbook

This skill is a process playbook, not a bundled design system. The concrete design system for a product lives in the consuming repository, starting at `design-system/GUIDELINES.md`. Keep taste guidance here as reusable judgment; keep token values, component catalogs, brand rules, and project-specific decisions in the consuming repo.

Use this skill when asked to propose UI directions, create or extend a repo's design-system documentation, generate reviewable design artifacts, or run a design-review loop.

## Taste guidance

Use these references as an evaluative lens, not as copied data:

- Material Design 3, "Design tokens" — https://m3.material.io/foundations/design-tokens
- U.S. Web Design System, "Design principles" — https://designsystem.digital.gov/design-principles
- U.S. Web Design System, "Design tokens" — https://designsystem.digital.gov/design-tokens
- Vercel, "Web Interface Guidelines" — https://vercel.com/design/guidelines
- W3C Design Tokens Community Group specification — https://www.designtokens.org/TR/2025.10/

Apply taste as prose judgment:

- Spacing rhythm: choose a limited spacing rhythm and repeat it. Related elements should sit closer together than unrelated elements; page regions should breathe enough to make scanning possible. Avoid one-off spacing decisions that cannot be explained by the repo's guidelines or token layer.
- Visual hierarchy: make the primary action, primary content, and reading order obvious before decoration. Use size, weight, proximity, alignment, and contrast to guide attention. If everything competes, the design has no hierarchy.
- Contrast: maintain clear contrast for text, controls, focus indicators, and important state changes. Contrast is about legibility and state recognition, not only color pairs. Do not rely on hue alone to communicate meaning.
- Restraint: prefer fewer type treatments, fewer accents, fewer shadows, and fewer competing surfaces. Add emphasis only where it clarifies priority or interaction. Remove ornamental choices that do not serve comprehension, trust, or task completion.
- Consistency: repeat successful patterns across related screens. When a direction introduces a new pattern, state why it is better than reusing an existing one.
- Accessibility: treat keyboard navigation, focus visibility, hit targets, motion sensitivity, and readable copy as design constraints, not cleanup tasks.

## Governance rules

### No hardcoded values

Do not place raw visual values directly into generated directions, project guidelines, or production-facing artifacts when an equivalent token or guideline exists. Raw values may appear only as provisional sketch details inside `.pi/design/<id>/option-N/` while exploring; before promotion, replace them with repo-approved tokens or record the missing token decision in `design-system/GUIDELINES.md`.

### Token tiers

Follow the W3C Design Tokens model and the Material Design three-tier convention:

1. Primitive/reference tokens describe reusable raw ingredients. They are the only tier that may bind to literal values in a graduated token pipeline.
2. Semantic/system tokens describe intent and product meaning. They alias primitive/reference tokens.
3. Component tokens describe component-scoped decisions. They alias semantic/system tokens.

Component tokens must reference semantic/system tokens, never primitive/reference tokens and never raw values. If the repo has no token pipeline yet, apply the same rule in prose: component-level design decisions should point back to semantic roles in `design-system/GUIDELINES.md`.

### Naming conventions

- Token names should be stable, lowercase, and dot-separated when the consuming repo uses DTCG-style JSON. Keep names about role and intent, not current appearance.
- Primitive/reference token names describe families and scale positions. Semantic/system token names describe UI roles, states, and interaction meaning. Component token names start from the component or pattern name and end with the property being controlled.
- Direction IDs should be short, filesystem-safe slugs. Use one directory per exploration round at `.pi/design/<id>/`, with options named `option-1/`, `option-2/`, and so on.
- A direction name should describe the concept in human terms. Avoid names tied to raw visual values or implementation libraries unless the user explicitly requested that constraint.

## Repo-specific guideline linking

Always reference the consuming repo's concrete guidelines with the repo-root-relative path `design-system/GUIDELINES.md`, resolved from the worker's current working directory.

Do not reference repo-specific guidelines by traversing from this skill's directory. In pi, this skill may be surfaced through a symlink under the user's global skills directory; parent-directory traversal from the skill directory can escape into the wrong location.

## Bootstrap a consuming repo

When the current working repo has no `design-system/` directory:

1. Create `design-system/`.
2. Create `design-system/GUIDELINES.md` with the project's concrete taste, accessibility expectations, accepted patterns, and unresolved design decisions. Seed it from the current product context and the references above; do not add token values or component catalogs by default.
3. Add `.pi/design/` to the repo's `.gitignore` if it is not already ignored.
4. Do not create `design-system/tokens/` or `design-system/components/` unless the human explicitly asks to graduate the repo to a real token/component system or those directories already exist. Graduation is a separate design-system task, not the default bootstrap.

If `design-system/GUIDELINES.md` already exists, read it before generating directions. Its project-specific rules override the generic taste guidance in this skill.

## Runtime artifact convention

Write exploratory design directions to a gitignored runtime directory in the consuming repo:

```text
.pi/design/<id>/
  index.html
  option-1/
    artifact.html or artifact.svg
    rationale.md
    inventory.md
  option-2/
    artifact.html or artifact.svg
    rationale.md
    inventory.md
  option-3/
    artifact.html or artifact.svg
    rationale.md
    inventory.md
```

Default to 3 directions per round unless the user asks for a different count. Each `option-N/` contains:

- the HTML or SVG artifact to review;
- a one-line rationale explaining the direction;
- the list of tokens, guidelines, and repo-specific rules it used or proposes.

The gallery at `.pi/design/<id>/index.html` should be a simple static page that links to each `option-N/` artifact and displays each option's one-line rationale. It should not depend on a build step. Keep the gallery disposable; the accepted direction is promoted separately.

## Render-and-critique loop

For each round:

1. Read `design-system/GUIDELINES.md` when it exists, plus any relevant product requirements.
2. Write the directions and gallery to `.pi/design/<id>/`.
3. Render or inspect the artifacts. Use the `visualize` tool for standalone SVG. Use a browser or static preview for HTML and galleries.
4. Critique each option against the taste guidance in this skill and the concrete rules in `design-system/GUIDELINES.md`.
5. Revise before handoff when the critique finds unclear hierarchy, weak contrast, inconsistent rhythm, hardcoded values that should be tokens, inaccessible states, or ornamental clutter.
6. Present the gallery path and ask the human to pick a direction, reject all directions, or request another round.

The loop is not complete until the worker has looked at the rendered output or has explicitly reported why rendering was unavailable.

## Promote on accept

When the human chooses an option:

1. Confirm the selected option path, such as `.pi/design/<id>/option-N/`.
2. Copy only the accepted option's durable artifacts into `design-system/` in the consuming repo. Use a project-appropriate subdirectory under `design-system/` for archived directions or source assets.
3. Update `design-system/GUIDELINES.md` with accepted design decisions, rationale, accessibility constraints, and any token or pattern names the project should keep.
4. If the repo already has token or component directories, update them through the repo's existing conventions. Preserve the three-tier rule: components reference semantic/system tokens, not primitives or raw values.
5. Leave rejected options in `.pi/design/<id>/`; they remain disposable runtime artifacts and should stay ignored by git.

Do not promote token values, component code, or brand decisions that the human did not accept. If acceptance is ambiguous, ask before changing `design-system/`.
