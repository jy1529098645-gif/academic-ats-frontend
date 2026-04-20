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
// Every user-visible field carries a `description` that tells the user exactly
// what to write, plus a `required` flag.
// ─────────────────────────────────────────────────────────────────────────────

export type LabExtraField = {
  key: string;                 // payload key sent to the backend
  label: string;
  placeholder: string;
  description: string;         // "what exactly should I put here?"
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
    blurb: "A themed tour of the existing research on your topic.",
    coreLabel: "Research topic / question",
    coreDescription: "One sentence. The specific topic or question the review should map. Be narrow — 'CBT for insomnia in adolescents' is better than 'mental health'.",
    corePlaceholder: "e.g. What is the effect of mindfulness apps on undergraduate anxiety?",
    coreRequired: true,
    coreRows: 2,
    pointsLabel: "Themes to cover",
    pointsDescription: "Each theme becomes a subsection the review must address (e.g. 'methodological trends', 'contested findings', 'populations studied'). 3–5 themes is typical.",
    pointsAddLabel: "+ Add theme",
    pointsPlaceholder: (i) => i === 0 ? "e.g. methodological trends" : `Theme ${i + 1}…`,
    pointsRequired: false,
    extras: [
      { key: "time_frame",       label: "Time frame",           description: "Which window the review should cover. Leave blank for no restriction.", placeholder: "e.g. 2014–present",                       required: false },
      { key: "theoretical_lens", label: "Preferred lens / frame", description: "Theoretical stance or filter you want applied — e.g. post-colonial, RCT-only, cognitivist.", placeholder: "e.g. RCT-only evidence",                  required: false },
    ],
  },
  theoretical_framework: {
    id: "theoretical_framework",
    blurb: "An integrated model that explains a phenomenon.",
    coreLabel: "Concept you want to theorise",
    coreDescription: "Name the phenomenon the framework should explain in one sentence.",
    corePlaceholder: "e.g. Why remote teams disengage after 18 months.",
    coreRequired: true,
    coreRows: 2,
    pointsLabel: "Anchor theories to reconcile",
    pointsDescription: "Established theories the new framework should incorporate or argue against. Include the author in brackets where possible.",
    pointsAddLabel: "+ Add theory",
    pointsPlaceholder: (i) => i === 0 ? "e.g. Social Cognitive Theory (Bandura)" : `Theory ${i + 1}…`,
    pointsRequired: true,
    extras: [
      { key: "discipline",      label: "Discipline",       description: "Field the framework lives in — shapes which conventions the writer follows.", placeholder: "e.g. organisational behaviour", required: true },
      { key: "unit_of_analysis", label: "Unit of analysis", description: "Whose behaviour / dynamic the framework explains.",                       placeholder: "individual · team · organisation · policy", required: true },
      { key: "boundary_conditions", label: "Boundary conditions", description: "Where the framework is meant NOT to apply — makes the scope honest.", placeholder: "e.g. excludes crisis settings",      required: false, rows: 2 },
    ],
  },
  research_proposal: {
    id: "research_proposal",
    blurb: "A proposal for a study you plan to run.",
    coreLabel: "Research question",
    coreDescription: "The single question the proposed study will answer. Start with What / How / Why.",
    corePlaceholder: "e.g. How does peer feedback affect programming skill retention?",
    coreRequired: true,
    coreRows: 2,
    pointsLabel: "Sub-questions / aims",
    pointsDescription: "2–4 measurable aims the proposal must address. Each aim should be answerable by the methods you list below.",
    pointsAddLabel: "+ Add aim",
    pointsPlaceholder: (i) => `Aim ${i + 1}…`,
    pointsRequired: true,
    extras: [
      { key: "hypothesis", label: "Working hypothesis",  description: "Your expected answer, directional if possible. 'Students who receive peer feedback will retain X% more skill than controls.'", placeholder: "e.g. Group A will show higher retention than Group B at 3-month follow-up.", required: true, rows: 2 },
      { key: "methods",    label: "Planned methods",    description: "Design + data + analysis, one paragraph. E.g. 'Mixed-methods: online survey (n≈300) + 20 semi-structured interviews, thematic analysis.'", placeholder: "Design, data source, analytic technique.", required: true, rows: 3 },
      { key: "population", label: "Population / sample", description: "Who you will study, where you will recruit, target N.",      placeholder: "e.g. 300 CS undergrads at two universities", required: true },
      { key: "ethics",     label: "Ethical considerations", description: "Key risks + how you mitigate them (consent, anonymity, sensitive populations).", placeholder: "e.g. IRB approval planned; written consent required.", required: false, rows: 2 },
    ],
  },
  discussion: {
    id: "discussion",
    blurb: "The Discussion section of a paper that already has results.",
    coreLabel: "Results to discuss",
    coreDescription: "Summarise the findings this Discussion must interpret. Include direction of effects and key numbers.",
    corePlaceholder: "e.g. Intervention group showed a 12% (p<.01) increase in retention; effect stronger among first-year students.",
    coreRequired: true,
    coreRows: 3,
    pointsLabel: "Interpretations to pursue",
    pointsDescription: "The specific angles the Discussion should take on the results — e.g. 'mechanism: social facilitation'.",
    pointsAddLabel: "+ Add interpretation",
    pointsPlaceholder: (i) => `Interpretation ${i + 1}…`,
    pointsRequired: true,
    extras: [
      { key: "limitations",  label: "Key limitations to flag",  description: "Methodological weaknesses the Discussion must own honestly — one per line.", placeholder: "e.g. cross-sectional design",            required: true,  multi: true, addLabel: "+ Add limitation" },
      { key: "implications", label: "Practical / theoretical implications", description: "What this changes — for practice, policy, or theory.",         placeholder: "e.g. supports scaling peer-tutor programs", required: true,  rows: 2 },
      { key: "prior_work",   label: "Prior work to reconcile",  description: "Studies that agree / disagree with your findings; the Discussion will situate your results against them.", placeholder: "e.g. Smith 2019 found the opposite in K-12.", required: false, rows: 2 },
    ],
  },
  introduction: {
    id: "introduction",
    blurb: "The Introduction section that sets up a paper.",
    coreLabel: "Central claim of the paper",
    coreDescription: "The one sentence the Introduction must build toward. This is the thesis the rest of the paper defends.",
    corePlaceholder: "e.g. Peer feedback produces durable skill gains comparable to instructor feedback.",
    coreRequired: true,
    coreRows: 2,
    pointsLabel: "Background threads to introduce",
    pointsDescription: "Topic strands the Introduction must establish before presenting the gap — e.g. 'why retention matters', 'prior peer-feedback research'.",
    pointsAddLabel: "+ Add thread",
    pointsPlaceholder: (i) => `Thread ${i + 1}…`,
    pointsRequired: true,
    extras: [
      { key: "gap_statement", label: "The research gap",  description: "What is missing in the existing literature — the Introduction lands here before stating your contribution.", placeholder: "e.g. No study has tracked retention past 6 months.", required: true, rows: 2 },
      { key: "contribution",  label: "Your contribution", description: "What you add that did not exist before. Keep it concrete.",                                            placeholder: "e.g. A 24-month longitudinal dataset with N=412.",    required: true, rows: 2 },
    ],
  },
  conclusion: {
    id: "conclusion",
    blurb: "The Conclusion section that closes a paper.",
    coreLabel: "Thesis to restate",
    coreDescription: "The claim the Conclusion should land on. Mirrors the thesis from the Introduction, usually strengthened by the results.",
    corePlaceholder: "e.g. Peer feedback is a scalable complement to instructor feedback.",
    coreRequired: true,
    coreRows: 2,
    pointsLabel: "Key findings to remind the reader of",
    pointsDescription: "3–5 headline findings the Conclusion should echo — one line each.",
    pointsAddLabel: "+ Add finding",
    pointsPlaceholder: (i) => `Finding ${i + 1}…`,
    pointsRequired: true,
    extras: [
      { key: "future_work", label: "Future work",       description: "Concrete directions the next study should take — not vague 'more research is needed'.", placeholder: "e.g. Replicate in non-STEM cohorts.", required: false, multi: true, addLabel: "+ Add direction" },
      { key: "take_home",   label: "Take-home message", description: "The single sentence you want the reader to carry away — shown as the last line.",    placeholder: "e.g. Feedback quality matters more than source.", required: true },
    ],
  },
  abstract: {
    id: "abstract",
    blurb: "A structured 150–250-word abstract for a paper.",
    coreLabel: "One-sentence gist of the paper",
    coreDescription: "If you only had one sentence, what is the paper about?",
    corePlaceholder: "e.g. An 18-month study showing peer feedback matches instructor feedback on skill retention.",
    coreRequired: true,
    coreRows: 2,
    pointsLabel: null,
    extras: [
      { key: "background",   label: "Background / motivation", description: "Why does this study matter — 1–2 sentences.",            placeholder: "e.g. Retention gaps widen in large-enrollment classes.", required: true,  rows: 2 },
      { key: "methods",      label: "Methods",                 description: "Design, data, analytic approach — 1–2 sentences.",        placeholder: "e.g. Mixed-methods, n=412, propensity-matched.",          required: true,  rows: 2 },
      { key: "findings",     label: "Key findings",            description: "Headline results. Include effect direction and size.",    placeholder: "e.g. 12% higher retention at 18 months (p<.01).",        required: true,  rows: 3 },
      { key: "implications", label: "Implications",            description: "What changes because of these results — one sentence.",   placeholder: "e.g. Supports wider adoption of peer-led review.",       required: true  },
    ],
  },
  argumentative_essay: {
    id: "argumentative_essay",
    blurb: "A persuasive academic essay that argues for a position.",
    coreLabel: "Thesis",
    coreDescription: "The single claim the essay argues for. It must be debatable — if nobody could disagree, it is not a thesis.",
    corePlaceholder: "e.g. University grading should be replaced with formative assessment.",
    coreRequired: true,
    coreRows: 2,
    pointsLabel: "Supporting arguments",
    pointsDescription: "Each argument becomes a body paragraph. Aim for 3 arguments that build on each other rather than overlap.",
    pointsAddLabel: "+ Add argument",
    pointsPlaceholder: (i) => `Argument ${i + 1}…`,
    pointsRequired: true,
    extras: [
      { key: "counterarguments", label: "Counterarguments to address", description: "The strongest objections an informed critic would raise — the essay will rebut each.", placeholder: "e.g. 'Grades motivate students'",     required: true,  multi: true, addLabel: "+ Add counterargument" },
      { key: "audience",         label: "Intended audience",           description: "Who the essay is written for — tunes voice and jargon level.",                         placeholder: "e.g. policy brief for university admins", required: false },
    ],
  },
};

export function labFieldSpec(outputType: string): LabFieldSpec {
  return LAB_FIELD_SPECS[outputType] ?? LAB_FIELD_SPECS.literature_review;
}

export function labPointsPlaceholder(spec: LabFieldSpec): (i: number) => string {
  return spec.pointsPlaceholder ?? defaultPointsPlaceholder;
}
