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
  acceptUpload?: boolean;      // if true → render a "Upload .pdf/.txt/.md" button
                               //          that extracts the file's text and
                               //          fills this field. Used for fields
                               //          where the user is more likely to
                               //          have an existing document (resume,
                               //          existing draft) than to retype it.
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
  personal_statement: {
    id: "personal_statement",
    blurb: "A personal essay for grad-school / scholarship / job applications.",
    coreLabel: "Your driving motivation",
    coreDescription: "What pulls you toward this path — the through-line of the essay. One short paragraph.",
    corePlaceholder: "e.g. Watching my grandmother struggle with a smartphone made me realise accessibility-first AI is the gap I want to spend my career filling.",
    coreRequired: true,
    coreRows: 3,
    pointsLabel: "Experiences / qualities to highlight",
    pointsDescription: "Specific moments, projects, or strengths the essay should weave in. 3–5 work best.",
    pointsAddLabel: "+ Add experience",
    pointsPlaceholder: (i) => i === 0 ? "e.g. Led a 6-month research project on screen-reader UX" : `Experience ${i + 1}…`,
    pointsRequired: true,
    extras: [
      { key: "target_program",    label: "Target program / role",                 description: "Specific name + institution.",                                                placeholder: "e.g. MS in Computer Science, Stanford University",                              required: true },
      { key: "opening_anecdote",  label: "Opening moment / anecdote",             description: "A specific memory or turning point to anchor the opening. Optional but powerful.", placeholder: "e.g. The first time I saw my code help someone in a wheelchair navigate campus.", required: false, rows: 3 },
      { key: "future_goals",      label: "Future goals",                          description: "What you want to do during and after this program / role.",                  placeholder: "e.g. Build assistive AI tools at a major tech company; eventually start a non-profit.", required: true, rows: 2 },
      { key: "fit_with_program",  label: "Why this program / role specifically",  description: "Concrete reasons — faculty, courses, team, resources.",                       placeholder: "e.g. Want to work with Prof. X on assistive AI; CMU's HCI lab matches my methodology exactly.", required: false, rows: 2 },
      { key: "word_limit",        label: "Word / page limit",                     description: "What the application asks for. Optional.",                                    placeholder: "e.g. 750 words / 2 pages",                                                       required: false },
      // Resume reference — optional. Lets the writer agent pull
      // concrete dates / titles / companies from the user's actual CV
      // instead of inventing them. The acceptUpload flag turns on a
      // small file-extract button next to the textarea so the user
      // can drop a .pdf/.txt/.md instead of pasting.
      { key: "resume_text",       label: "Your resume (optional reference)",      description: "Paste or upload your resume. The writer will use it for accurate dates, titles, and projects — won't include it verbatim.", placeholder: "Paste your resume here, or click 'Upload' to extract from a .pdf / .txt / .md file…", required: false, rows: 8, acceptUpload: true },
    ],
  },

  resume: {
    id: "resume",
    blurb: "An ATS-friendly resume / CV tuned for student + early-career applications.",
    coreLabel: "Target role + level",
    coreDescription: "The position you're applying for and your stage. Sets the tone of the whole document.",
    corePlaceholder: "e.g. Software Engineering Internship — undergraduate junior, summer 2026",
    coreRequired: true,
    coreRows: 2,
    pointsLabel: "Top headline qualifications",
    pointsDescription: "3–5 one-line highlights for the summary statement at the top of the resume.",
    pointsAddLabel: "+ Add highlight",
    pointsPlaceholder: (i) => i === 0 ? "e.g. Built a real-time chat app handling 10k concurrent users" : `Highlight ${i + 1}…`,
    pointsRequired: false,
    extras: [
      { key: "contact_info",          label: "Contact info",                          description: "Name, email, phone, LinkedIn, location — one line.",                                placeholder: "Jane Doe · jane@cmu.edu · +1-412-555-0123 · linkedin.com/in/janedoe · Pittsburgh PA",                                                                                                                                  required: true,  rows: 2 },
      { key: "education",             label: "Education",                             description: "School(s), degree(s), GPA, relevant coursework. One school per block, most recent first.", placeholder: "e.g. Carnegie Mellon University — BS Computer Science — 2024–2027 — GPA 3.8/4.0\nRelevant coursework: Distributed Systems, ML Theory, HCI",                                                                  required: true,  rows: 4 },
      { key: "work_experience",       label: "Work experience",                       description: "Each role: company · title · dates · 2–3 achievement bullets. Most recent first.",   placeholder: "e.g. Google — SWE Intern — Jun–Aug 2025\n— Reduced p99 latency on Maps autocomplete by 38% via radix-tree refactor\n— Shipped to production used by 50M+ DAU\n\nMeta — Research Assistant — 2024 (semester)\n— Trained transformer for code-completion benchmark; +12% acc over baseline", required: true, rows: 8 },
      { key: "skills",                label: "Skills",                                description: "Technical + tools. Group by category if you can (Languages / Frameworks / Tools).",   placeholder: "e.g. Languages: Python, Go, TypeScript, Rust\nFrameworks: React, FastAPI, PyTorch\nTools: Git, Docker, AWS, Kubernetes",                                                                                                          required: true,  rows: 3 },
      { key: "projects",              label: "Projects",                              description: "Personal / academic projects. Each: name · stack · 1–2 outcome bullets.",            placeholder: "e.g. AcademiCats — Multi-agent academic search tool — Next.js + FastAPI\n— 1k+ users in alpha; multi-agent peer-review pipeline for paper drafts\n\nCampus Lost & Found — React + Firebase\n— Used by 200+ classmates; 95%+ recovery rate",                          required: false, rows: 5 },
      { key: "awards_certifications", label: "Awards / certifications",               description: "Honors, scholarships, certifications. Optional.",                                   placeholder: "e.g. Dean's List (2024, 2025); AWS Certified Solutions Architect; Putnam Honorable Mention",                                                                                                                          required: false, rows: 2 },
      { key: "extracurriculars",      label: "Extracurriculars / leadership",         description: "Clubs, volunteer, side roles. Optional.",                                          placeholder: "e.g. ACM Student Chapter — VP, 2024–present\nHabitat for Humanity — Volunteer, 100+ hours",                                                                                                                            required: false, rows: 2 },
      { key: "languages_spoken",      label: "Languages spoken",                      description: "Spoken languages + proficiency. Optional.",                                        placeholder: "e.g. English (native), Mandarin (fluent), Spanish (intermediate)",                                                                                                                                                    required: false },
      { key: "target_companies",      label: "Target companies (style hint)",         description: "Optional — tells the writer what tone to match (FAANG vs startup vs research).",   placeholder: "e.g. FAANG, top-tier startups, ML research labs",                                                                                                                                                                     required: false },
    ],
  },
};

export function labFieldSpec(outputType: string): LabFieldSpec {
  return LAB_FIELD_SPECS[outputType] ?? LAB_FIELD_SPECS.literature_review;
}

export function labPointsPlaceholder(spec: LabFieldSpec): (i: number) => string {
  return spec.pointsPlaceholder ?? defaultPointsPlaceholder;
}
