import { BasePatternDetector, type DetectionContext } from "./base-detector.js";

/**
 * Detector for "waiting for input" patterns
 * Tests against last 5 lines to catch multi-line prompts
 */
export class WaitingInputDetector extends BasePatternDetector {
  protected getTargetText(context: DetectionContext): string {
    // Check last 5 lines to catch multi-line "waiting" messages
    return context.last5Lines;
  }
}
