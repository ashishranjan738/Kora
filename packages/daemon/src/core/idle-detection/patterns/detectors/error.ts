import { BasePatternDetector, type DetectionContext } from "./base-detector.js";

/**
 * Detector for error patterns
 * Tests against last 5 lines to catch error messages
 */
export class ErrorDetector extends BasePatternDetector {
  protected getTargetText(context: DetectionContext): string {
    // Check last 5 lines to catch multi-line error messages
    return context.last5Lines;
  }
}
