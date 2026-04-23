// ─────────────────────────────────────────────────────────────────────────────
// Per-output-type input specs for the Synthesis Lab.
// Each entry defines what the user should fill in to produce that kind of text.
// The Lab form re-renders these whenever `labOutputType` changes.
//
// Field anatomy per type:
//   core      — the single most important field (thesis / question / topic)
//   points    — a list of sub-items the generator should cover (optional; set to
//               null to hide the list entirely, e.g. Abstract has no points list)
//   extras    — additional fields. Each can be single-entry or multi (with +Add)
//
// Copy guideline: every user-visible label / description / blurb should be
// scannable at a glance — one short sentence or a noun phrase, no more.
// Users filling out the Lab form shouldn't have to read a paragraph per
// field; they already know what a "thesis" or "research question" is, and
// the placeholder carries the concrete example.
// ─────────────────────────────────────────────────────────────────────────────

export type LabExtraField = {
  key: string;                 // payload key sent to the backend
  label: string;
  placeholder: string;
  description: string;         // "what exactly should I put here?" — 1 short line
  required: boolean;
  multi?: boolean;             // if true → list with +Add button, stored as string[]
  addLabel?: string;           // label for the +Add button when multi=true
  rows?: number;               // textarea with N rows; absent = single-line input
};

export type LabFieldSpec = {
  id: string;
  blurb: string;               // one-line description of the output type itself
  // Core input (thesis / main question)
  coreLabel: string;
  coreDescription: string;
  corePlaceholder: string;
  coreRequired: boolean;
  coreRows?: number;
  // Points list
  pointsLabel?: string | null;   // null → no points list
  pointsDescription?: string;
  pointsAddLabel?: string;
  pointsPlaceholder?: (i: number) => string;
  pointsRequired?: boolean;
  // Additional fields
  extras?: LabExtraField[];
};

const defaultPointsPlaceholder = (i: number) => `Point ${i + 1}…`;

export const LAB_FIELD_SPECS: Record<string, LabFieldSpec> = {
  literature_review: {
    id: "literature_review",
    blurb: "A themed map of existing research.",
    coreLabel: "Research topic / question",
    coreDescription: "One narrow topic or question.",
    corePlaceholder: "e.g. What is the effect of mindfulness apps on undergraduate anxiety?",
    coreRequired: true,
    coreRows: 2,
    pointsLabel: "Themes to cover",
    pointsDescription: "Each theme becomes a subsection. 3–5 works well.",
    pointsAddLabel: "+ Add theme",
    pointsPlaceholder: (i) => i === 0 ? "e.g. methodological trends" : `Theme ${i + 1}…`,
    pointsRequired: false,
    extras: [
      { key: "time_frame",       label: "Time frame",             description: "Year range. Optional.",           placeholder: "e.g. 2014–present",       required: false },
      { key: "theoretical_lens", label: "Preferred lens / frame", description: "Lens or filter to apply.",        placeholder: "e.g. RCT-only evidence",  required: false },
    ],
  },
  theoretical_framework: {
    id: "theoretical_framework",
    blurb: "A model that explains a phenomenon.",
    coreLabel: "Concept you want to theorise",
    coreDescription: "Name what the model should explain.",
    corePlaceholder: "e.g. Why remote teams disengage after 18 months.",
    coreRequired: true,
    coreRows: 2,
    pointsLabel: "Anchor theories to reconcile",
    pointsDescription: "Theories to build on or argue against.",
    pointsAddLabel: "+ Add theory",
    pointsPlaceholder: (i) => i === 0 ? "e.g. Social Cognitive Theory (Bandura)" : `Theory ${i + 1}…`,
    pointsRequired: true,
    extras: [
      { key: "discipline",          label: "Discipline",          description: "The field it belongs to.",          placeholder: "e.g. organisational behaviour",             required: true },
      { key: "unit_of_analysis",    label: "Unit of analysis",    description: "Who or what it explains.",          placeholder: "individual · team · organisation · policy", required: true },
      { key: "boundary_conditions", label: "Boundary conditions", description: "Where it doesn't apply.",           placeholder: "e.g. excludes crisis settings",             required: false, rows: 2 },
    ],
  },
  research_proposal: {
    id: "research_proposal",
    blurb: "A proposal for a study.",
    coreLabel: "Research question",
    coreDescription: "The main question. Start with What / How / Why.",
    corePlaceholder: "e.g. How does peer feedback affect programming skill retention?",
    coreRequired: true,
    coreRows: 2,
    pointsLabel: "Sub-questions / aims",
    pointsDescription: "2–4 measurable aims.",
    pointsAddLabel: "+ Add aim",
    pointsPlaceholder: (i) => `Aim ${i + 1}…`,
    pointsRequired: true,
    extras: [
      { key: "hypothesis", label: "Working hypothesis",      description: "Expected answer, directional if possible.", placeholder: "e.g. Group A will show higher retention than Group B at 3-month follow-up.", required: true, rows: 2 },
      { key: "methods",    label: "Planned methods",         description: "Design + data + analysis, one paragraph.",  placeholder: "Design, data source, analytic technique.",                                     required: true, rows: 3 },
      { key: "population", label: "Population / sample",     description: "Who you'll recruit + target N.",           placeholder: "e.g. 300 CS undergrads at two universities",                                  required: true },
      { key: "ethics",     label: "Ethical considerations",  description: "Key risks + mitigation.",                  placeholder: "e.g. IRB approval planned; written consent required.",                        required: false, rows: 2 },
    ],
  },
  discussion: {
    id: "discussion",
    blurb: "Discussion section for an existing study.",
    coreLabel: "Results to discuss",
    coreDescription: "The findings, with direction + key numbers.",
    corePlaceholder: "e.g. Intervention group showed a 12% (p<.01) increase in retention; effect stronger among first-year students.",
    coreRequired: true,
    coreRows: 3,
    pointsLabel: "Interpretations to pursue",
    pointsDescription: "Specific angles on the results.",
    pointsAddLabel: "+ Add interpretation",
    pointsPlaceholder: (i) => `Interpretation ${i + 1}…`,
    pointsRequired: true,
    extras: [
      { key: "limitations",  label: "Key limitations to flag",              description: "Weaknesses to own — one per line.",  placeholder: "e.g. cross-sectional design",               required: true,  multi: true, addLabel: "+ Add limitation" },
      { key: "implications", label: "Practical / theoretical implications", description: "What this changes.",                  placeholder: "e.g. supports scaling peer-tutor programs", required: true,  rows: 2 },
      { key: "prior_work",   label: "Prior work to reconcile",              description: "Studies that agree or disagree.",     placeholder: "e.g. Smith 2019 found the opposite in K-12.", required: false, rows: 2 },
    ],
  },
  introduction: {
    id: "introduction",
    blurb: "Introduction section for a paper.",
    coreLabel: "Central claim of the paper",
    coreDescription: "The one sentence the intro builds toward.",
    corePlaceholder: "e.g. Peer feedback produces durable skill gains comparable to instructor feedback.",
    coreRequired: true,
    coreRows: 2,
    pointsLabel: "Background threads to introduce",
    pointsDescription: "Strands to set up before the gap.",
    pointsAddLabel: "+ Add thread",
    pointsPlaceholder: (i) => `Thread ${i + 1}…`,
    pointsRequired: true,
    extras: [
      { key: "gap_statement", label: "The research gap",  description: "What the literature is missing.", placeholder: "e.g. No study has tracked retention past 6 months.", required: true, rows: 2 },
      { key: "contribution",  label: "Your contribution", description: "What you add that's new.",         placeholder: "e.g. A 24-month longitudinal dataset with N=412.",    required: true, rows: 2 },
    ],
  },
  conclusion: {
    id: "conclusion",
    blurb: "Conclusion section for a paper.",
    coreLabel: "Thesis to restate",
    coreDescription: "Where the conclusion should land.",
    corePlaceholder: "e.g. Peer feedback is a scalable complement to instructor feedback.",
    coreRequired: true,
    coreRows: 2,
    pointsLabel: "Key findings to remind the reader of",
    pointsDescription: "3–5 headline findings, one line each.",
    pointsAddLabel: "+ Add finding",
    pointsPlaceholder: (i) => `Finding ${i + 1}…`,
    pointsRequired: true,
    extras: [
      { key: "future_work", label: "Future work",       description: "Concrete next steps.",               placeholder: "e.g. Replicate in non-STEM cohorts.",             required: false, multi: true, addLabel: "+ Add direction" },
      { key: "take_home",   label: "Take-home message", description: "The last line readers remember.",   placeholder: "e.g. Feedback quality matters more than source.", required: true },
    ],
  },
  abstract: {
    id: "abstract",
    blurb: "A 150–250-word abstract.",
    coreLabel: "One-sentence gist of the paper",
    coreDescription: "If you had one sentence, what's it about?",
    corePlaceholder: "e.g. An 18-month study showing peer feedback matches instructor feedback on skill retention.",
    coreRequired: true,
    coreRows: 2,
    pointsLabel: null,
    extras: [
      { key: "background",   label: "Background / motivation", description: "Why it matters. 1–2 sentences.",      placeholder: "e.g. Retention gaps widen in large-enrollment classes.", required: true,  rows: 2 },
      { key: "methods",      label: "Methods",                 description: "Design + data + approach.",            placeholder: "e.g. Mixed-methods, n=412, propensity-matched.",          required: true,  rows: 2 },
      { key: "findings",     label: "Key findings",            description: "Headline results with direction + size.", placeholder: "e.g. 12% higher retention at 18 months (p<.01).",       required: true,  rows: 3 },
      { key: "implications", label: "Implications",            description: "What this changes. One sentence.",     placeholder: "e.g. Supports wider adoption of peer-led review.",       required: true  },
    ],
  },
  argumentative_essay: {
    id: "argumentative_essay",
    blurb: "An essay that argues a position.",
    coreLabel: "Thesis",
    coreDescription: "The debatable claim the essay defends.",
    corePlaceholder: "e.g. University grading should be replaced with formative assessment.",
    coreRequired: true,
    coreRows: 2,
    pointsLabel: "Supporting arguments",
    pointsDescription: "Each becomes a body paragraph. Aim for 3.",
    pointsAddLabel: "+ Add argument",
    pointsPlaceholder: (i) => `Argument ${i + 1}…`,
    pointsRequired: true,
    extras: [
      { key: "counterarguments", label: "Counterarguments to address", description: "Objections the essay will rebut.", placeholder: "e.g. 'Grades motivate students'",           required: true,  multi: true, addLabel: "+ Add counterargument" },
      { key: "audience",         label: "Intended audience",           description: "Who it's written for.",             placeholder: "e.g. policy brief for university admins",   required: false },
    ],
  },
};

export function labFieldSpec(outputType: string): LabFieldSpec {
  return LAB_FIELD_SPECS[outputType] ?? LAB_FIELD_SPECS.literature_review;
}

export function labPointsPlaceholder(spec: LabFieldSpec): (i: number) => string {
  return spec.pointsPlaceholder ?? defaultPointsPlaceholder;
}
