import { BasePatternDetector, type DetectionContext } from "./base-detector.js";

/**
 * Detector for agent spawn patterns
 * Tests against full output to handle empty output case
 */
export class SpawnDetector extends BasePatternDetector {
  protected getTargetText(context: DetectionContext): string {
    // For spawn detection, check if output is empty or has spawn indicators
    if (context.fullOutput.trim() === "") {
      return "";
    }
    return context.last5Lines;
  }
}
