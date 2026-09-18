import type { ClarifyingQuestion, TaskType } from "@/types";

/**
 * Baseline question set for each task type. Triggered sets in
 * `triggeredSets.ts` are appended on top of these when the description
 * matches a more specific pattern (a game, a store, a login flow, ...).
 */
export const CORE_BY_TYPE: Record<TaskType, ClarifyingQuestion[]> = {
  coding: [
    {
      id: "goal",
      question: "What should the finished code actually do?",
      hint: "Describe the behaviour someone could observe, not the files you expect.",
      defaultValue: "Solve the stated problem correctly, with clear behaviour that can be exercised and verified.",
    },
    {
      id: "language",
      question: "Which language, runtime or framework should it be written in?",
      defaultValue: "Use the language implied by the request, or the most common choice for this kind of problem.",
      options: ["TypeScript (Node)", "Python", "Go", "Rust", "JavaScript (browser)"],
    },
    {
      id: "inputs",
      question: "What are the inputs and expected outputs?",
      hint: "Concrete examples pin the contract down faster than a description.",
      defaultValue: "Accept the obvious inputs for this problem and return a single well-defined result.",
    },
    {
      id: "quality",
      question: "How much supporting work do you want alongside the working code?",
      defaultValue: "Working code, clear naming, brief inline comments where non-obvious, and a short usage example.",
      options: [
        "Just working code",
        "Code plus a short usage example",
        "Code, tests and usage example",
        "Fully documented with tests and edge-case handling",
      ],
    },
  ],

  "web-development": [
    {
      id: "purpose",
      question: "Who is this for, and what should it contain?",
      hint: "Audience and content shape structure more than anything else.",
      defaultValue: "A general audience; a clean, credible presentation of the core content.",
      options: [
        "Personal portfolio",
        "Business marketing site",
        "Content or blog site",
        "Product landing page",
      ],
    },
    {
      id: "stack",
      question: "What tech stack should be used?",
      defaultValue: "Use the stack the user implied, or a sensible modern default for this kind of site.",
      options: ["React + TypeScript + Tailwind", "Next.js + TypeScript + Tailwind", "Plain HTML, CSS and JS", "Vue or Svelte"],
    },
    {
      id: "design",
      question: "What design style or visual direction do you want?",
      defaultValue: "Clean, modern and restrained: neutral palette, generous spacing, strong typography.",
      options: [
        "Minimal and editorial",
        "Bold and colourful",
        "Dark, high contrast",
        "Corporate and understated",
      ],
    },
    {
      id: "sections",
      question: "Which pages or sections are required?",
      hint: "List them in the order a visitor should encounter them.",
      defaultValue: "A single page with a clear hero, the main content, and a closing call to action.",
      options: [
        "Single page: hero, about, work, contact",
        "Home, about, projects, contact",
        "Home, services, pricing, FAQ, contact",
      ],
    },
    {
      id: "features",
      question: "Which interactive features matter?",
      defaultValue: "Responsive layout, accessible navigation and working links.",
      options: [
        "Responsive mobile layout",
        "Dark mode toggle",
        "Animated scroll effects",
        "Working contact form",
        "Search or filtering",
      ],
    },
  ],

  research: [
    {
      id: "question",
      question: "What is the specific question this research should answer?",
      hint: "A question is easier to research than a topic.",
      defaultValue: "Answer the question implied by the request as directly and concretely as possible.",
    },
    {
      id: "depth",
      question: "How deep should the research go?",
      defaultValue: "A solid overview covering the main positions, with enough detail to act on.",
      options: [
        "Quick orientation",
        "Solid overview",
        "Detailed survey",
        "Exhaustive deep dive",
      ],
    },
    {
      id: "sources",
      question: "Which sources or perspectives should it prioritise?",
      defaultValue: "Prioritise the most credible and widely accepted sources, and note where opinion diverges.",
    },
    {
      id: "output",
      question: "What form should the findings take?",
      defaultValue: "A structured written summary with clear sections and a short conclusion.",
      options: [
        "Written summary",
        "Comparison table",
        "Annotated bibliography",
        "Recommendation with rationale",
      ],
    },
  ],

  writing: [
    {
      id: "audience",
      question: "Who is reading this?",
      hint: "Audience drives vocabulary, length and tone more than any other choice.",
      defaultValue: "A general adult reader with no prior context.",
    },
    {
      id: "tone",
      question: "What tone should it take?",
      defaultValue: "Clear, direct and neutral.",
      options: ["Neutral and informative", "Conversational", "Persuasive", "Formal"],
    },
    {
      id: "format",
      question: "What format and roughly how long?",
      defaultValue: "A well-structured piece of a length appropriate to the subject.",
      options: [
        "Short (a few paragraphs)",
        "Medium article",
        "Long-form piece",
        "Outline first",
      ],
    },
    {
      id: "points",
      question: "Are there specific points it must cover?",
      defaultValue: "Cover the points implied by the request, in a logical order.",
    },
  ],

  "document-analysis": [
    {
      id: "goal",
      question: "What decision or outcome should this analysis support?",
      hint: "An analysis with a purpose is far more useful than a summary.",
      defaultValue: "Summarise the document faithfully and surface everything that matters for the stated purpose.",
    },
    {
      id: "focus",
      question: "What should it focus on, or deliberately ignore?",
      defaultValue: "Focus on the substance of the document; skip boilerplate and formatting details.",
    },
    {
      id: "output",
      question: "How should the findings be presented?",
      defaultValue: "A structured summary followed by the notable findings as clear bullet points.",
      options: [
        "Executive summary",
        "Bulleted findings",
        "Structured report",
        "Extracted data",
      ],
    },
  ],

  "data-analysis": [
    {
      id: "question",
      question: "What question should the analysis answer?",
      defaultValue: "Answer the question implied by the request and report the uncertainty honestly.",
    },
    {
      id: "shape",
      question: "What does the data look like, and what shape is it in?",
      hint: "Messy data needs cleaning steps that are easy to forget otherwise.",
      defaultValue: "Assume typical real-world data: some missing values and inconsistent formatting worth checking first.",
    },
    {
      id: "output",
      question: "What output do you need?",
      defaultValue: "A short written interpretation supported by the relevant numbers.",
      options: [
        "Written interpretation",
        "Summary statistics",
        "Charts or visualisations",
        "Reproducible code plus results",
      ],
    },
    {
      id: "rigor",
      question: "How rigorous should it be?",
      defaultValue: "Sound and defensible: state assumptions, and do not overclaim from limited data.",
      options: [
        "Quick directional read",
        "Sound and defensible",
        "Statistically rigorous",
      ],
    },
  ],

  planning: [
    {
      id: "outcome",
      question: "What does success look like?",
      defaultValue: "A clear, achievable outcome that follows directly from the request.",
    },
    {
      id: "constraints",
      question: "What constraints bind it — time, budget, people, dependencies?",
      defaultValue: "Assume ordinary constraints: limited time and a single person executing.",
    },
    {
      id: "horizon",
      question: "What time horizon should the plan cover?",
      defaultValue: "A short-to-medium horizon with clear near-term next steps.",
      options: [
        "Immediate next steps only",
        "A few weeks",
        "A few months",
        "Long-term roadmap",
      ],
    },
    {
      id: "format",
      question: "How should the plan be structured?",
      defaultValue: "Phased steps in order, each with a clear outcome and a rough effort estimate.",
      options: [
        "Ordered steps",
        "Phases with milestones",
        "Prioritised backlog",
        "Timeline with dates",
      ],
    },
  ],

  creative: [
    {
      id: "goal",
      question: "What should this achieve or make someone feel?",
      defaultValue: "Achieve the effect implied by the request with originality and coherence.",
    },
    {
      id: "style",
      question: "What style, genre or reference points should it follow?",
      defaultValue: "A coherent, original style appropriate to the brief.",
    },
    {
      id: "constraints",
      question: "What should it avoid, or stay within?",
      defaultValue: "Avoid cliché and generic phrasing; stay within the scope implied by the request.",
    },
    {
      id: "deliverable",
      question: "What exactly should be produced?",
      defaultValue: "One complete, polished deliverable ready to use.",
      options: [
        "A single finished piece",
        "Several variants to choose from",
        "An outline or sketch first",
      ],
    },
  ],

  general: [
    {
      id: "outcome",
      question: "What does a good result look like here?",
      defaultValue: "A complete, directly usable result that addresses the request as stated.",
    },
    {
      id: "constraints",
      question: "Is there anything it must respect or avoid?",
      defaultValue: "Respect the constraints implied by the request; avoid unnecessary scope.",
    },
    {
      id: "detail",
      question: "How much detail do you want in the result?",
      defaultValue: "Enough detail to act on immediately, without padding.",
      options: ["Brief and to the point", "Moderate detail", "Thorough"],
    },
    {
      id: "format",
      question: "How should the result be presented?",
      defaultValue: "Clearly structured prose with sections where they help.",
    },
  ],
};