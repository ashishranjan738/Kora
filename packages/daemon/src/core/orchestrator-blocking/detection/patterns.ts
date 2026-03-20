/**
 * Pattern Library for Orchestrator Blocking Detection
 *
 * This module defines regex patterns for detecting when the orchestrator
 * needs user input and should enter BLOCKED state.
 *
 * Categories:
 * - DECISION: Decision points requiring user judgment
 * - RISK: Risky operations requiring confirmation
 * - MISSING_INFO: Unclear requirements or missing context
 * - CONFLICT: Agent disagreements or contradictory requirements
 * - ERROR: Critical failures requiring user intervention
 */

export enum BlockingCategory {
  DECISION = "decision",
  RISK = "risk",
  MISSING_INFO = "missing_info",
  CONFLICT = "conflict",
  ERROR = "error",
  NONE = "none"
}

export interface PatternDefinition {
  category: BlockingCategory;
  patterns: RegExp[];
  weight: number; // Points added to score per match
  priority: number; // 1 (highest) - 5 (lowest)
  description: string;
}

/**
 * Blocking patterns organized by category
 * Each pattern match adds to the total blocking score
 */
export const BLOCKING_PATTERNS: Record<string, PatternDefinition> = {
  // ============================================================
  // CATEGORY 1: DECISION PATTERNS (60% of blocking cases)
  // ============================================================

  DECISION_QUESTIONS: {
    category: BlockingCategory.DECISION,
    patterns: [
      /should I (do|use|implement|merge|deploy|create|delete|update|proceed)/i,
      /which (option|approach|solution|strategy|tool|method|technique|library|framework)/i,
      /do you (want|prefer|think I should|recommend)/i,
      /would you like me to/i,
      /(your|user) (preference|decision|call|choice|input|judgment)/i,
      /or should I/i,
      /what (would|should) (you|I) (do|choose|prefer)/i,
      /how (would|should) (you|I) (proceed|handle|approach)/i,
    ],
    weight: 30, // Increased from 25
    priority: 1,
    description: "Direct decision questions requiring user judgment"
  },

  MULTIPLE_OPTIONS: {
    category: BlockingCategory.DECISION,
    patterns: [
      /(option [A-Z]|approach \d+|strategy [A-Z\d]+).*(option [A-Z]|approach \d+|strategy [A-Z\d]+)/i,
      /alternatively/i,
      /here are (\d+|several|multiple|two|three) (options|approaches|strategies|solutions|ways)/i,
      /we (could|can|might) (either|also)/i,
    ],
    weight: 20,
    priority: 2,
    description: "Presenting multiple options to user"
  },

  TRADE_OFFS: {
    category: BlockingCategory.DECISION,
    patterns: [
      /(pros|advantages|benefits).*(cons|disadvantages|trade-?offs|drawbacks|downsides)/i,
      /on (the )?one hand.*(on (the )?other hand|however|but)/i,
      /(faster|quicker|simpler).*(but|however).*(risky|riskier|complex|slower)/i,
      /(safer|more reliable).*(but|however).*(slower|more complex)/i,
    ],
    weight: 15,
    priority: 3,
    description: "Discussing trade-offs requiring user to weigh options"
  },

  PREFERENCE_QUESTIONS: {
    category: BlockingCategory.DECISION,
    patterns: [
      /what'?s your preference/i,
      /which (one )?do you prefer/i,
      /let me know (your|what you) prefer/i,
      /waiting for your decision/i,
      /need your decision/i,
    ],
    weight: 30, // Increased from 25
    priority: 1,
    description: "Explicitly asking for user preference"
  },

  // ============================================================
  // CATEGORY 2: RISK PATTERNS (20% of blocking cases)
  // ============================================================

  RISK_CONFIRMATION: {
    category: BlockingCategory.RISK,
    patterns: [
      /this (will|would|could) (delete|remove|break|override|destroy|wipe)/i,
      /are you sure.*(want|proceed|continue|go ahead)/i,
      /confirm.*(destructive|risky|critical|dangerous)/i,
      /please confirm (before|that you want)/i,
      /⚠️.*confirm/i,
      /warning:.*proceed/i,
    ],
    weight: 30,
    priority: 1,
    description: "Confirmation required for risky operations"
  },

  DESTRUCTIVE_OPERATIONS: {
    category: BlockingCategory.RISK,
    patterns: [
      /(delete|remove|drop|wipe|purge).*(production|database|table|data|file)/i,
      /force (push|deploy|delete|merge)/i,
      /reset --hard/i,
      /irreversible (action|operation|change)/i,
      /cannot be undone/i,
      /no (way|ability) to (roll ?back|undo|recover)/i,
    ],
    weight: 30,
    priority: 1,
    description: "Destructive operations that cannot be undone"
  },

  RISK_INDICATORS: {
    category: BlockingCategory.RISK,
    patterns: [
      /(risky|dangerous|breaking|destructive|hazardous)/i,
      /requires? (careful consideration|elevated permissions|admin access)/i,
      /(may|might|could) (break|cause).*(production|backward compatibility|existing)/i,
      /security (risk|concern|implication)/i,
    ],
    weight: 20,
    priority: 2,
    description: "General risk indicators"
  },

  // ============================================================
  // CATEGORY 3: MISSING INFO PATTERNS (10% of blocking cases)
  // ============================================================

  MISSING_INFO: {
    category: BlockingCategory.MISSING_INFO,
    patterns: [
      /need (your|user|more) (input|information|clarification|details) (on|about)/i,
      /unclear (requirement|specification|goal|objective|acceptance criteria)/i,
      /(what|which).*(is the|are the).*(requirement|goal|priority|target|expectation)/i,
      /need (to know|clarification on|more details about)/i,
      /(not sure|unclear|ambiguous).*(what|which|how|when)/i,
      /before I (can )?(proceed|continue|move forward)/i,
    ],
    weight: 25,
    priority: 2,
    description: "Missing information needed to proceed"
  },

  UNCLEAR_REQUIREMENTS: {
    category: BlockingCategory.MISSING_INFO,
    patterns: [
      /requirements? (is|are) (unclear|ambiguous|vague|undefined)/i,
      /specification (is unclear|lacks detail)/i,
      /(what|which) (should|is the).*(priority|target|scope)/i,
      /need (more|additional) context/i,
      /insufficient (information|details|context)/i,
    ],
    weight: 25,
    priority: 2,
    description: "Requirements are unclear or ambiguous"
  },

  CLARIFICATION_REQUESTS: {
    category: BlockingCategory.MISSING_INFO,
    patterns: [
      /can you clarify/i,
      /please clarify/i,
      /need clarification/i,
      /could you (explain|elaborate)/i,
      /what (exactly |precisely )?do you mean/i,
    ],
    weight: 20,
    priority: 3,
    description: "Direct requests for clarification"
  },

  // ============================================================
  // CATEGORY 4: CONFLICT PATTERNS (5% of blocking cases)
  // ============================================================

  CONFLICTS: {
    category: BlockingCategory.CONFLICT,
    patterns: [
      /conflict between/i,
      /disagreement.*(agent|team member|requirement)/i,
      /contradictory/i,
      /(agent [A-Z\w-]+) says.*(but|however).*(agent [A-Z\w-]+) says/i,
      /conflicting (information|requirements|approaches)/i,
      /merge conflict/i,
    ],
    weight: 25,
    priority: 1,
    description: "Conflicts requiring user resolution"
  },

  AGENT_DISAGREEMENTS: {
    category: BlockingCategory.CONFLICT,
    patterns: [
      /(agents?|team members?) (disagree|don'?t agree)/i,
      /different (opinions|views|approaches) (from|between)/i,
      /can'?t (reach|come to) (agreement|consensus)/i,
    ],
    weight: 25,
    priority: 1,
    description: "Agent disagreements on approach or implementation"
  },

  // ============================================================
  // CATEGORY 5: ERROR PATTERNS (5% of blocking cases)
  // ============================================================

  CRITICAL_ERRORS: {
    category: BlockingCategory.ERROR,
    patterns: [
      /critical (error|failure|issue)/i,
      /all agents (are )?(down|unavailable|crashed)/i,
      /(cannot|unable to) (access|connect to|reach).*(API|service|system)/i,
      /system (is )?(unavailable|unreachable|down)/i,
      /blocking (bug|issue|error)/i,
    ],
    weight: 30,
    priority: 1,
    description: "Critical system errors requiring intervention"
  },

  SERVICE_UNAVAILABLE: {
    category: BlockingCategory.ERROR,
    patterns: [
      /(GitHub|API|service|database) (is )?(unavailable|down|unreachable)/i,
      /connection (refused|timeout|failed)/i,
      /authentication failed/i,
      /rate limit exceeded/i,
      /quota exceeded/i,
    ],
    weight: 25,
    priority: 2,
    description: "External service unavailability"
  },
};

/**
 * Non-blocking patterns - messages that should NOT trigger blocking
 * These override blocking patterns (early exit if matched)
 */
export const NON_BLOCKING_PATTERNS: RegExp[] = [
  // Rhetorical questions
  /what'?s next/i,
  /how'?s (it|that) going/i,
  /right\?$/i,
  /isn'?t it/i,
  /don'?t you think/i,

  // Status updates
  /(status|progress) (update|report)/i,
  /here'?s what (I|we).*(did|completed|finished|accomplished)/i,
  /completed successfully/i,

  // Information delivery (FYI)
  /FYI/i,
  /for your information/i,
  /just letting you know/i,
  /heads up/i,

  // Autonomous action statements
  /executing|proceeding|starting|continuing/i,
  /I'?ll (continue|proceed|start|begin) with/i,
  /moving (forward|ahead) with/i,
  /going to (implement|create|build)/i,

  // Acknowledgments
  /got it|understood|acknowledged/i,
  /will do|on it/i,
];

/**
 * Explicit blocking marker - if orchestrator uses this syntax,
 * immediately enter BLOCKED state
 */
export const EXPLICIT_BLOCK_MARKER = /```blocking-request/i;

/**
 * Helper function to get all pattern categories
 */
export function getCategories(): BlockingCategory[] {
  return Object.values(BlockingCategory).filter(c => c !== BlockingCategory.NONE);
}

/**
 * Helper function to count total patterns
 */
export function countPatterns(): number {
  return Object.values(BLOCKING_PATTERNS).reduce(
    (total, def) => total + def.patterns.length,
    0
  );
}

/**
 * Helper function to get patterns by category
 */
export function getPatternsByCategory(category: BlockingCategory): PatternDefinition[] {
  return Object.values(BLOCKING_PATTERNS).filter(p => p.category === category);
}
