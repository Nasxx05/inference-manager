import type { ClarifyingQuestion } from "@/types";

export interface TriggeredSet {
  id: string;
  /** When the description matches this, the set is appended. */
  match: RegExp;
  questions: ClarifyingQuestion[];
}

/**
 * Extra question sets for recognisable sub-kinds of task. These run in
 * addition to the core set, so "build a tic-tac-toe game" gets game-specific
 * questions rather than only generic coding questions.
 */
export const TRIGGERED_SETS: TriggeredSet[] = [
  {
    /**
     * RAG / retrieval systems.
     *
     * These questions exist because each answer materially changes the
     * workload: a local in-memory store and a hosted vector database differ by
     * an order of magnitude in integration and revision effort, and evaluation
     * is a whole extra phase. Asking is what stops "build a RAG agent" from
     * being priced as if it were one small task.
     */
    id: "rag",
    match:
      /\b(rag|retrieval[- ]?augmented|embedding|embeddings|vector (db|database|store|storage|search)|semantic search|document (ingestion|processing|qa|question)|knowledge base|chunking|rerank|similarity search)\b/i,
    questions: [
      {
        id: "rag_documents",
        question: "What kind of documents will it process?",
        hint: "Document type drives parsing, chunking and context size — a large cost factor.",
        defaultValue: "Plain text and Markdown files, with PDFs handled as plain text.",
        options: [
          "Plain text and Markdown",
          "PDFs with layout and tables",
          "HTML pages or scraped web content",
          "Code repositories",
          "Mixed document types",
        ],
      },
      {
        id: "rag_vector_store",
        question: "Which vector store should it use?",
        hint: "A hosted service adds integration work; a local store keeps it self-contained.",
        defaultValue: "A local in-memory vector store, so the project runs without external services.",
        options: [
          "Local in-memory store",
          "Local persistent store (for example SQLite-backed)",
          "Hosted vector database",
          "Existing store I will configure myself",
        ],
        singleSelect: true,
      },
      {
        id: "rag_evaluation",
        question: "Do you need retrieval evaluation?",
        hint: "Evaluation is a substantial extra phase, not a small addition.",
        defaultValue: "A lightweight evaluation with a small set of representative questions.",
        options: [
          "No evaluation for now",
          "Lightweight: a small set of test questions with spot checks",
          "Full: a labelled dataset with retrieval quality metrics",
        ],
        singleSelect: true,
      },
      {
        id: "rag_scope",
        question: "Which parts are in scope?",
        hint: "Each selected part is a real implementation phase.",
        defaultValue:
          "Document ingestion, chunking, embeddings, vector storage, retrieval and generation.",
        options: [
          "Document ingestion and chunking",
          "Embeddings",
          "Vector storage",
          "Retrieval and context construction",
          "Generation with citations",
          "Authentication and multi-user support",
          "Deployment guidance",
        ],
      },
      {
        id: "rag_backend",
        question: "Do you already have a backend or should one be created?",
        hint: "Creating a backend adds API, storage and deployment work.",
        defaultValue: "Create a minimal backend for ingestion and querying.",
        options: [
          "Create a minimal backend",
          "I already have a backend to integrate with",
          "No backend — a local script or notebook is enough",
        ],
        singleSelect: true,
      },
    ],
  },
  {
    /**
     * SaaS platforms.
     *
     * A "complete SaaS" brief is underspecified by nature: the number of
     * subsystems decides whether this is a small prototype or a large build.
     * These questions surface which layers actually exist before estimating.
     */
    id: "saas",
    match:
      /\b(saas|multi[- ]?tenant|subscription|billing|admin (panel|dashboard)|user management|production[- ]ready|production[- ]quality|full[- ]stack platform|platform with)\b/i,
    questions: [
      {
        id: "saas_type",
        question: "What kind of SaaS is this?",
        hint: "The domain decides which features are essential versus optional.",
        defaultValue:
          "A general-purpose web application with accounts and a main dashboard workspace.",
        options: [
          "Analytics or reporting tool",
          "Project or task management tool",
          "Content or publishing platform",
          "Marketplace or booking platform",
          "Internal business tool",
        ],
        singleSelect: true,
      },
      {
        id: "saas_layers",
        question: "Which layers must be included?",
        hint: "Each layer is a substantial implementation area with its own revision cycles.",
        defaultValue:
          "Authentication, database, backend API, main dashboard UI and basic deployment.",
        options: [
          "Authentication",
          "Database and data models",
          "Backend API",
          "Frontend dashboard UI",
          "Payments and subscriptions",
          "Admin dashboard",
          "Analytics and reporting",
          "Deployment and infrastructure",
        ],
      },
      {
        id: "saas_stack",
        question: "Is there a required stack?",
        hint: "A fixed stack narrows the work; an open choice adds a decision phase.",
        defaultValue: "No fixed stack — choose a conventional, well-supported one.",
        options: [
          "No fixed stack, choose a conventional one",
          "Next.js and TypeScript",
          "React with a separate backend",
          "Python backend",
          "Something else I will specify",
        ],
        singleSelect: true,
      },
      {
        id: "saas_payments",
        question: "Are real payments required, or is a simulation enough?",
        hint: "Real payment processing carries significant integration and testing work.",
        defaultValue: "Simulated billing only — no real payment provider integration.",
        options: [
          "No billing for now",
          "Simulated billing with mock data",
          "Real payment provider integration",
        ],
        singleSelect: true,
      },
      {
        id: "saas_fidelity",
        question: "What level of fidelity do you need?",
        hint: "Prototype versus production-ready is the single biggest driver of effort here.",
        defaultValue:
          "A working prototype with core flows, clean structure and minimal tests.",
        options: [
          "Prototype: core flows only",
          "Functional: core flows plus tests and error handling",
          "Production-ready: tests, monitoring, migrations and deployment",
        ],
        singleSelect: true,
      },
    ],
  },
  {
    id: "game",
    match:
      /\b(game|tic[- ]?tac[- ]?toe|noughts|chess|checkers|sudoku|snake|tetris|pong|puzzle|platformer|multiplayer|turn[- ]based|board game|card game|player vs)\b/i,
    questions: [
      {
        id: "game_mode",
        question: "Should it be single-player or multiplayer?",
        hint: "This decides whether you need an opponent AI or a turn system.",
        defaultValue: "Two players sharing the same screen, taking turns.",
        options: [
          "Two players on the same device",
          "Single player against the computer",
          "Online multiplayer",
          "Both: local two-player plus a computer opponent",
        ],
        singleSelect: true,
      },
      {
        id: "game_difficulty",
        question: "If there is a computer opponent, how should it play?",
        defaultValue: "A competent opponent that plays reasonably but stays beatable.",
        options: [
          "Random moves",
          "Blocks obvious wins but is beatable",
          "Strong and hard to beat",
          "Unbeatable",
        ],
        singleSelect: true,
      },
      {
        id: "game_visuals",
        question: "What visual style do you want?",
        defaultValue: "Clean and modern, with clear feedback on every move.",
        options: [
          "Clean and minimal",
          "Playful and colourful",
          "Retro or pixel art",
          "Dark and neon",
        ],
        singleSelect: true,
      },
      {
        id: "game_rules",
        question: "How should winning, losing and draws be handled?",
        defaultValue:
          "Detect a win or a draw immediately, announce the result clearly, and disable further moves until restart.",
        options: [
          "Announce the result and stop play",
          "Announce and offer an instant rematch",
          "Highlight the winning line, then offer a rematch",
          "Track a running score across rounds",
        ],
        singleSelect: true,
      },
      {
        id: "game_extras",
        question: "Which extras do you want?",
        hint: "Restart and a turn indicator are the two people most often miss.",
        defaultValue: "A restart button and a clear indicator of whose turn it is.",
        options: [
          "Restart button",
          "Score tracking across rounds",
          "Turn indicator",
          "Animations or sound",
          "Move history and undo",
          "Keep it minimal",
        ],
      },
      {
        id: "game_platform",
        question: "Where should it run?",
        defaultValue: "In the browser, as a single self-contained page.",
        options: [
          "Browser, plain HTML/CSS/JS",
          "Browser, React",
          "Terminal or command line",
          "Mobile app",
        ],
        singleSelect: true,
      },
    ],
  },
  {
    id: "ecommerce",
    match:
      /\b(ecommerce|e-commerce|online store|web ?shop|shopify|storefront|shopping cart|cart|checkout|product page|product listing|marketplace|order)\b/i,
    questions: [
      {
        id: "catalog",
        question: "What is being sold, and how should the catalogue be organised?",
        defaultValue:
          "A modest catalogue of representative products, organised into a few clear categories, using placeholder data.",
        options: [
          "A handful of placeholder products",
          "Products grouped into categories",
          "Products with variants (size, colour)",
          "Imported from an external source",
        ],
        singleSelect: true,
      },
      {
        id: "checkout",
        question: "How far should the purchase flow go?",
        hint: "Real payment processing is usually much more than people expect.",
        defaultValue:
          "A simulated checkout flow with a mock payment step and no real payment processor integration.",
        options: [
          "Browse and cart only",
          "Simulated checkout with mock payment",
          "Real payment integration",
        ],
        singleSelect: true,
      },
      {
        id: "accounts",
        question: "Do users need accounts, or is guest checkout enough?",
        defaultValue: "Guest checkout only, with no user accounts required.",
        options: ["Guest checkout only", "Optional accounts", "Accounts required"],
        singleSelect: true,
      },
    ],
  },
  {
    id: "auth",
    match:
      /\b(auth|authentication|authorization|login|log ?in|sign ?in|sign ?up|signin|signup|register|registration|user accounts|session|oauth|jwt)\b/i,
    questions: [
      {
        id: "auth_method",
        question: "How should users authenticate?",
        defaultValue:
          "Email and password, with the password hashed and never stored or logged in plain text.",
        options: [
          "Email and password",
          "Email with a verification link",
          "Social or OAuth sign-in",
          "Passkeys or biometrics",
        ],
        singleSelect: true,
      },
      {
        id: "auth_storage",
        question: "Where should sessions and user data live?",
        hint: "This determines how much backend work is involved.",
        defaultValue:
          "A simple server-side session stored in a database, with an httpOnly secure cookie in the browser.",
        options: [
          "Server-side sessions in a database",
          "Signed stateless tokens (JWT)",
          "Managed auth service",
          "In-memory only, for a prototype",
        ],
        singleSelect: true,
      },
    ],
  },
  {
    id: "api",
    match:
      /\b(api|apis|rest|restful|graphql|endpoint|endpoints|backend service|microservice|webhook|rpc)\b/i,
    questions: [
      {
        id: "api_style",
        question: "What style should the interface use?",
        defaultValue: "A conventional REST API with predictable resource-based URLs and JSON bodies.",
        options: ["REST", "GraphQL", "RPC-style endpoints", "Webhooks only"],
        singleSelect: true,
      },
      {
        id: "api_surface",
        question: "Which operations should it expose?",
        hint: "List the handful of operations that actually matter.",
        defaultValue:
          "The standard create, read, update and delete operations for the main resource implied by the request.",
      },
      {
        id: "api_contract",
        question: "How should requests and responses be defined and validated?",
        defaultValue:
          "Validate every request against an explicit schema and return clear, structured errors with correct status codes.",
        options: [
          "Explicit schema validation",
          "Light manual checks",
          "Generated types and documentation",
        ],
        singleSelect: true,
      },
    ],
  },
  {
    id: "mobile",
    match: /\b(mobile app|ios app|android app|react native|flutter|expo|tablet)\b/i,
    questions: [
      {
        id: "platform",
        question: "Which platforms must it support?",
        defaultValue: "Both iOS and Android from a single shared codebase.",
        options: ["iOS only", "Android only", "Both from one codebase"],
        singleSelect: true,
      },
      {
        id: "device_features",
        question: "Which device capabilities does it need?",
        defaultValue: "None beyond a responsive, touch-friendly interface.",
        options: [
          "Camera or photo library",
          "Location",
          "Push notifications",
          "Local storage or offline use",
          "None of these",
        ],
      },
    ],
  },
  {
    id: "data-persistence",
    match: /\b(database|persist|persistence|save data|store data|sql|postgres|mysql|sqlite|mongo|orm)\b/i,
    questions: [
      {
        id: "storage_choice",
        question: "What should store the data?",
        defaultValue: "A simple relational database with a small, clear schema.",
        options: [
          "SQLite or a local file",
          "PostgreSQL",
          "MongoDB",
          "Browser or device local storage",
        ],
        singleSelect: true,
      },
      {
        id: "schema_shape",
        question: "What are the main records, and how do they relate?",
        defaultValue:
          "The obvious main record implied by the request, with an id, the core fields, and timestamps.",
      },
    ],
  },
];