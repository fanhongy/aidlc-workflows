# Learning Loop Rules

## Overview

These rules capture institutional knowledge across sessions so that agents avoid repeating mistakes, remember architectural decisions, and build on lessons learned from failures. Entries are stored in `aidlc-docs/lessons/` with one file per category:

- `aidlc-docs/lessons/footguns.md` - reproducible hazards and traps encountered during development
- `aidlc-docs/lessons/decisions.md` - architectural decision records (ADR-style entries)
- `aidlc-docs/lessons/takeaways.md` - reusable lessons learned from failures and fixes

**Enforcement**: At each applicable stage, the model MUST verify compliance with these rules before presenting the stage completion message to the user.

### Blocking LEARNING Finding Behavior

A **blocking learning finding** means:

1. The finding MUST be listed in the stage completion message under a "Learning Loop Findings" section with the LEARNING rule ID and description
2. The stage MUST NOT present the "Continue to Next Stage" option until all blocking findings are resolved
3. The model MUST present only the "Request Changes" option with a clear explanation of what needs to change
4. The finding MUST be logged in `aidlc-docs/audit.md` with the LEARNING rule ID, description, and stage context

If a LEARNING rule is not applicable to the current context (e.g., LEARNING-01 when no lessons files exist yet), mark it as **N/A** in the compliance summary - this is not a blocking finding.

### Default Enforcement

All rules in this document are **blocking** by default. If any rule's verification criteria are not met, it is a blocking learning finding - follow the blocking finding behavior defined above.

### Verification Criteria Format

Verification items in this document are plain bullet points describing compliance checks. They are distinct from the `- [ ]` / `- [x]` progress-tracking checkboxes used in stage plan files. Each item should be evaluated as compliant or non-compliant during review.

---

## Rule LEARNING-01: Session Start - Read Lessons

**Rule**: At the start of each session, the agent MUST read all existing lesson files in `aidlc-docs/lessons/` (footguns.md, decisions.md, takeaways.md) if they exist. Before making changes to any module, the agent MUST grep these files for entries related to that module or domain area and factor them into its approach.

**Verification**:

- Agent reads all existing files in `aidlc-docs/lessons/` at session start
- Agent checks lesson files for relevant entries before modifying a module
- No change is proposed that contradicts an active footgun or decision entry without explicit justification

---

## Rule LEARNING-02: Footgun Capture

**Rule**: When a VERIFY step catches a failure, or the agent corrects course on something that would cause repeated harm, the agent MUST append a structured entry to `aidlc-docs/lessons/footguns.md`. Footguns are reproducible hazards or traps - things that silently break or mislead when encountered again.

**Verification**:

- Every corrected failure that could recur has a corresponding footgun entry
- Entry is appended (not overwritten) to `aidlc-docs/lessons/footguns.md`
- Entry follows the structured format defined in LEARNING-05

---

## Rule LEARNING-03: Decision Recording

**Rule**: When an architectural or significant technical decision is made (technology choice, pattern selection, trade-off resolution, or scope boundary), the agent MUST append a structured entry to `aidlc-docs/lessons/decisions.md` as an ADR-style record. This includes decisions made during design stages and decisions made reactively during construction.

**Verification**:

- Every architectural or significant technical decision has a corresponding entry
- Entry is appended (not overwritten) to `aidlc-docs/lessons/decisions.md`
- Entry includes rationale and alternatives considered
- Entry follows the structured format defined in LEARNING-05

---

## Rule LEARNING-04: Takeaway Capture

**Rule**: When a fix completes or a lesson is learned from a failure, the agent MUST append a structured entry to `aidlc-docs/lessons/takeaways.md`. Takeaways are reusable insights - generalizable lessons that apply beyond the immediate fix.

**Verification**:

- Every resolved failure with a generalizable lesson has a corresponding takeaway entry
- Entry is appended (not overwritten) to `aidlc-docs/lessons/takeaways.md`
- Entry captures the generalized insight, not just the specific fix
- Entry follows the structured format defined in LEARNING-05

---

## Rule LEARNING-05: Entry Format

**Rule**: All entries in lesson files MUST follow the structured format below. Each entry is a markdown section with required metadata fields:

```markdown
### <Short descriptive title>

- **Status**: active | resolved
- **Created**: <ISO 8601 date, e.g. 2025-01-15>
- **Evidence**: <What happened - the observable symptom or trigger>
- **Prevention** (footguns): <How to avoid this in the future>
- **Rationale** (decisions): <Why this choice was made and what alternatives were rejected>
- **Lesson** (takeaways): <The generalized insight applicable beyond this specific case>
```

Use **Prevention** for footguns.md entries, **Rationale** for decisions.md entries, and **Lesson** for takeaways.md entries. The Status field allows marking entries as resolved when they no longer apply (e.g., a footgun fixed by a dependency upgrade).

**Verification**:

- Every entry has a heading (###) with a descriptive title
- Every entry has Status, Created, and Evidence fields
- Footgun entries have a Prevention field
- Decision entries have a Rationale field
- Takeaway entries have a Lesson field
- Status is either "active" or "resolved"
- Created date uses ISO 8601 format

---

## Enforcement Integration

These rules apply throughout all AI-DLC stages:

- LEARNING-01 applies at session start and before any module modification
- LEARNING-02 applies whenever a verification step fails or the agent corrects course
- LEARNING-03 applies during design and construction stages when decisions are made
- LEARNING-04 applies after fixes and failure resolutions
- LEARNING-05 applies to all entries written under LEARNING-02, LEARNING-03, and LEARNING-04

At each stage completion, include a "Learning Loop Compliance" section listing each rule as compliant, non-compliant, or N/A.
